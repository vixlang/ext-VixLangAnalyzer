import * as path from 'path';
import * as cp from 'child_process';
import * as fs from 'fs';
import {
    ExtensionContext, window, workspace, commands, Terminal, TextDocument,
    Diagnostic, DiagnosticSeverity, DiagnosticCollection, Range, Position, Uri, languages,
    OutputChannel
} from 'vscode';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind
} from 'vscode-languageclient/node';

let client: LanguageClient;
let compileTerminal: Terminal | undefined;
let diagnosticCollection: DiagnosticCollection;
let compileOutput: OutputChannel;
const AUTO_COMPILE_ARGS = '-ast';
const autoCompileTimers = new Map<string, ReturnType<typeof setTimeout>>();
const GENERATED_EXTENSIONS = ['.o', '.obj', '.s', '.asm'];
type CompilerErrorFormat = 'bootstrap' | 'c-cpp' | 'none';

interface CompileOption {
    label: string;
    description: string;
    args: string;
}

function getCompileOptions(): CompileOption[] {
    return [
        { label: '$(play)  Compile (l0)',          description: 'No optimization (fastest compile)',   args: '-opt=l0' },
        { label: '$(play)  Compile (l1)',          description: 'Basic optimization',                  args: '-opt=l1' },
        { label: '$(play)  Compile (l2)',          description: 'Standard optimization',               args: '-opt=l2' },
        { label: '$(play)  Compile (l3)',          description: 'Aggressive optimization',             args: '-opt=l3' },
        { label: '$(symbol-method)  Assembly (l0)', description: 'Generate assembly (-S), no optimization',  args: '-S -opt=l0' },
        { label: '$(symbol-method)  Assembly (l1)', description: 'Generate assembly (-S), basic optimization', args: '-S -opt=l1' },
        { label: '$(symbol-method)  Assembly (l2)', description: 'Generate assembly (-S), standard optimization', args: '-S -opt=l2' },
        { label: '$(symbol-method)  Assembly (l3)', description: 'Generate assembly (-S), aggressive optimization', args: '-S -opt=l3' },
        { label: '$(package)  Object File (l0)',   description: 'Generate object file (-obj), no optimization',  args: '-obj -opt=l0' },
        { label: '$(package)  Object File (l1)',   description: 'Generate object file (-obj), basic optimization', args: '-obj -opt=l1' },
        { label: '$(package)  Object File (l2)',   description: 'Generate object file (-obj), standard optimization', args: '-obj -opt=l2' },
        { label: '$(package)  Object File (l3)',   description: 'Generate object file (-obj), aggressive optimization', args: '-obj -opt=l3' }
    ];
}

/**
 * Parse compiler output and extract diagnostics.
 * Supports Rust/vixc style and many other common compiler error formats.
 *
 * vixc output format:
 *   error [Category]: message
 *   --> file:line:col
 *     |
 *   N | source line
 *     | ^
 *     |
 *   = help: hint message
 */
function getCompilerErrorFormat(): CompilerErrorFormat {
    return workspace.getConfiguration('vix').get<CompilerErrorFormat>('compilerErrorFormat', 'bootstrap');
}

function parseCompilerOutput(
    output: string,
    sourceFilePath: string,
    errorFormat: CompilerErrorFormat
): Map<string, Diagnostic[]> {
    const diagnosticsByFile = new Map<string, Diagnostic[]>();
    if (errorFormat === 'none') {
        return diagnosticsByFile;
    }

    const lines = output.split(/\r?\n/);

    // Pass: parse Rust-style multi-line errors
    // First collect all "severity [tag]: message" + "--> file:line:col" pairs
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        const sevMatch = /^(error|warning|note|info)\s*\[([^\]]+)\]\s*:\s*(.+)/i.exec(line);
        if (!sevMatch) continue;

        const tag = sevMatch[2];
        const matchesFormat = errorFormat === 'bootstrap'
            ? /\([^)]+\)/.test(tag)
            : !/\([^)]+\)/.test(tag);
        if (!matchesFormat) continue;

        const severity = sevMatch[1];
        const message = sevMatch[3];

        // Look ahead for "--> file:line:col"
        for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
            const pointerLine = lines[j].trim();
            const pointerMatch = /^-->\s+(.+?):(\d+):(\d+)\s*$/.exec(pointerLine);
            if (!pointerMatch) continue;

            const filePath = pointerMatch[1];
            const lineNum = parseInt(pointerMatch[2], 10);
            const colNum = parseInt(pointerMatch[3], 10);

            addDiagnostic(diagnosticsByFile, filePath, lineNum, colNum, severity, message, sourceFilePath);
            break;
        }
    }

    // If Rust-style parsing found nothing, try single-line patterns (GCC/Clang/MSVC)
    if (errorFormat === 'c-cpp' && diagnosticsByFile.size === 0) {
        const singleLinePatterns: RegExp[] = [
            // file:line:col: severity: message  (GCC/Clang)
            /^(.+?):(\d+):(\d+):\s*(error|warning|note|info|fatal error)\s*:?\s*(.*)/i,
            // file:line: severity: message  (GCC/Clang no col)
            /^(.+?):(\d+):\s*(error|warning|note|info|fatal error)\s*:?\s*(.*)/i,
            // file(line,col): severity: message  (MSVC)
            /^(.+?)\((\d+),(\d+)\):\s*(error|warning|note|info)\s*:?\s*(.*)/i,
            // file(line): severity: message  (MSVC no col)
            /^(.+?)\((\d+)\):\s*(error|warning|note|info)\s*:?\s*(.*)/i,
        ];

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            for (const pattern of singleLinePatterns) {
                const m = pattern.exec(trimmed);
                if (!m) continue;

                const filePath = m[1];
                const lineNum = parseInt(m[2], 10);
                const colNum = m[3] ? parseInt(m[3], 10) : 1;
                const severity = m[4];
                const message = m[5];

                addDiagnostic(diagnosticsByFile, filePath, lineNum, colNum, severity, message, sourceFilePath);
                break;
            }
        }
    }

    return diagnosticsByFile;
}

function addDiagnostic(
    diagnosticsByFile: Map<string, Diagnostic[]>,
    filePath: string,
    lineNum: number,
    colNum: number,
    severity: string,
    message: string,
    sourceFilePath: string
): void {
    // Resolve file path
    let resolvedPath = filePath;
    if (!path.isAbsolute(filePath)) {
        const folder = workspace.getWorkspaceFolder(Uri.file(sourceFilePath));
        if (folder) {
            resolvedPath = path.resolve(folder.uri.fsPath, filePath);
        } else {
            resolvedPath = path.resolve(path.dirname(sourceFilePath), filePath);
        }
    }
    resolvedPath = resolvedPath.replace(/\\/g, '/');

    const zeroLine = Math.max(0, lineNum - 1);
    const zeroCol = Math.max(0, colNum - 1);
    const sevLower = severity.toLowerCase();
    const diagSeverity = sevLower === 'error' || sevLower === 'fatal error'
        ? DiagnosticSeverity.Error
        : sevLower === 'warning'
            ? DiagnosticSeverity.Warning
            : sevLower === 'info'
                ? DiagnosticSeverity.Information
                : DiagnosticSeverity.Hint;

    // Try to get the actual line to set accurate end column
    let endCol = zeroCol + 1;
    try {
        const doc = workspace.textDocuments.find(d => d.fileName.replace(/\\/g, '/') === resolvedPath);
        if (doc && zeroLine < doc.lineCount) {
            const lineText = doc.lineAt(zeroLine).text;
            endCol = lineText.length > 0 ? lineText.length : zeroCol + 1;
        }
    } catch { /* ignore */ }

    const diagnostic = new Diagnostic(
        new Range(new Position(zeroLine, zeroCol), new Position(zeroLine, endCol)),
        message,
        diagSeverity
    );
    diagnostic.source = 'vixc';

    if (!diagnosticsByFile.has(resolvedPath)) {
        diagnosticsByFile.set(resolvedPath, []);
    }
    diagnosticsByFile.get(resolvedPath)!.push(diagnostic);
}

async function runCompile(extraArgs: string): Promise<void> {
    const editor = window.activeTextEditor;
    if (!editor) {
        window.showWarningMessage('No active editor found.');
        return;
    }

    await compileDocument(editor.document, extraArgs, true);
}

async function compileDocument(document: TextDocument, extraArgs: string, showTerminal: boolean): Promise<void> {
    if (document.languageId !== 'vix' || document.uri.scheme !== 'file') {
        return;
    }

    const errorFormat = getCompilerErrorFormat();
    if (errorFormat === 'none' && !showTerminal) {
        diagnosticCollection.delete(document.uri);
        return;
    }

    if (document.isDirty) {
        const saved = await document.save();
        if (!saved) {
            return;
        }
    }

    const filePath = document.fileName;
    const outputBasePath = path.join(path.dirname(filePath), path.parse(filePath).name);
    const compilerPath = workspace.getConfiguration('vix').get<string>('compilerPath', 'vixc');

    // Clear previous compiler diagnostics for this file only
    diagnosticCollection.delete(document.uri);

    // Show terminal with the command being run
    const fullCommand = `${compilerPath} "${filePath}" ${extraArgs}`;
    if (showTerminal) {
        if (!compileTerminal || compileTerminal.exitStatus !== undefined) {
            compileTerminal = window.createTerminal('Vix Compile');
        }
        compileTerminal.show();
        compileTerminal.sendText(fullCommand);
    }

    // Also run the compiler in background to capture output for diagnostics
    window.setStatusBarMessage('$(sync~spin) Vix: Compiling...', 2000);

    cp.execFile(compilerPath, [filePath, ...extraArgs.split(/\s+/).filter(Boolean)], {
        cwd: path.dirname(filePath),
        timeout: 30000
    }, (error, stdout, stderr) => {
        const allOutput = [stdout, stderr].filter(Boolean).join('\n');

        // Log raw compiler output for debugging
        compileOutput.appendLine(`[${new Date().toLocaleTimeString()}] ${fullCommand}`);
        if (allOutput.trim()) {
            compileOutput.appendLine(allOutput.trim());
        }
        if (error) {
            compileOutput.appendLine(`Exit code: ${error.code ?? 'unknown'}`);
        }
        compileOutput.appendLine('---');

        if (!allOutput.trim() && !error) {
            window.setStatusBarMessage('$(check) Vix: Compiled successfully', 3000);
            return;
        }

        // Parse compiler output for diagnostics
        const diagnosticsMap = parseCompilerOutput(allOutput, filePath, errorFormat);

        if (diagnosticsMap.size > 0) {
            for (const [file, diags] of diagnosticsMap) {
                diagnosticCollection.set(Uri.file(file), diags);
            }
            window.setStatusBarMessage('$(error) Vix: Compilation finished with errors', 3000);
        } else if (error && errorFormat !== 'none') {
            // Compiler exited with non-zero but we couldn't parse specific errors
            const fallbackDiag = new Diagnostic(
                new Range(new Position(0, 0), new Position(0, 0)),
                `Compiler exited with code ${error.code || 'unknown'}: ${allOutput.trim() || error.message}`,
                DiagnosticSeverity.Error
            );
            fallbackDiag.source = 'vixc';
            diagnosticCollection.set(Uri.file(filePath), [fallbackDiag]);
            window.setStatusBarMessage('$(error) Vix: Compilation failed', 3000);
        } else if (error) {
            window.setStatusBarMessage('$(error) Vix: Compilation failed (diagnostics disabled)', 3000);
        } else {
            // Output exists but no parsed diagnostics — show as info
            window.setStatusBarMessage('$(check) Vix: Compiled successfully', 3000);
        }

        void cleanupGeneratedArtifacts(outputBasePath, extraArgs);
    });
}

async function cleanupGeneratedArtifacts(outputBasePath: string, extraArgs: string): Promise<void> {
    const shouldClean = /(?:^|\s)-(?:obj|S)(?:\s|$)/.test(extraArgs);
    if (!shouldClean) {
        return;
    }

    const targets = GENERATED_EXTENSIONS.map(extension => `${outputBasePath}${extension}`);
    for (const target of targets) {
        try {
            await fs.promises.unlink(target);
        } catch {
            // Ignore missing files and permission issues for cleanup
        }
    }
}

function scheduleAutoCompile(document: TextDocument): void {
    if (document.languageId !== 'vix' || document.uri.scheme !== 'file') {
        return;
    }

    const key = document.uri.toString();
    const existingTimer = autoCompileTimers.get(key);
    if (existingTimer) {
        clearTimeout(existingTimer);
        autoCompileTimers.delete(key);
    }

    if (getCompilerErrorFormat() === 'none') {
        diagnosticCollection.delete(document.uri);
        return;
    }

    const timer = setTimeout(() => {
        autoCompileTimers.delete(key);
        void compileDocument(document, AUTO_COMPILE_ARGS, false);
    }, 700);

    autoCompileTimers.set(key, timer);
}

async function compileVix(): Promise<void> {
    const options = getCompileOptions();
    const selected = await window.showQuickPick(options, {
        placeHolder: 'Select compile mode and optimization level'
    });
    if (!selected) {
        return;
    }
    await runCompile(selected.args);
}

export async function activate(context: ExtensionContext) {
    // Create diagnostic collection for compiler errors
    diagnosticCollection = languages.createDiagnosticCollection('vixc');
    context.subscriptions.push(diagnosticCollection);

    // Create output channel for raw compiler output (visible via "Vix: Show Compiler Output" command)
    compileOutput = window.createOutputChannel('Vix Compiler');
    context.subscriptions.push(compileOutput);

    context.subscriptions.push(
        commands.registerCommand('vix.showCompilerOutput', () => compileOutput.show())
    );

    // Main compile button — opens menu with all options
    context.subscriptions.push(
        commands.registerCommand('vix.compile', () => compileVix())
    );

    // Direct compile commands with optimization level
    for (let i = 0; i <= 3; i++) {
        context.subscriptions.push(
            commands.registerCommand(`vix.compile.l${i}`, () => runCompile(`-opt=l${i}`))
        );
    }

    // Assembly output commands
    for (let i = 0; i <= 3; i++) {
        context.subscriptions.push(
            commands.registerCommand(`vix.compile.asm.l${i}`, () => runCompile(`-S -opt=l${i}`))
        );
    }

    // Object file output commands
    for (let i = 0; i <= 3; i++) {
        context.subscriptions.push(
            commands.registerCommand(`vix.compile.obj.l${i}`, () => runCompile(`-obj -opt=l${i}`))
        );
    }

    // Clear compiler diagnostics when file is saved (recompile via LSP handles its own diagnostics)
    context.subscriptions.push(
        workspace.onDidSaveTextDocument((doc) => {
            if (doc.languageId === 'vix') {
                // Don't auto-clear — user will re-compile manually
            }
        })
    );

    context.subscriptions.push(
        workspace.onDidOpenTextDocument((doc) => {
            scheduleAutoCompile(doc);
        })
    );

    context.subscriptions.push(
        workspace.onDidChangeTextDocument((event) => {
            scheduleAutoCompile(event.document);
        })
    );

    context.subscriptions.push(
        workspace.onDidChangeConfiguration((event) => {
            if (!event.affectsConfiguration('vix.compilerErrorFormat')) {
                return;
            }

            diagnosticCollection.clear();
            for (const timer of autoCompileTimers.values()) {
                clearTimeout(timer);
            }
            autoCompileTimers.clear();

            if (getCompilerErrorFormat() !== 'none') {
                workspace.textDocuments.forEach(scheduleAutoCompile);
            }
        })
    );

    context.subscriptions.push(
        workspace.onDidCloseTextDocument((doc) => {
            const key = doc.uri.toString();
            const existingTimer = autoCompileTimers.get(key);
            if (existingTimer) {
                clearTimeout(existingTimer);
                autoCompileTimers.delete(key);
            }
            diagnosticCollection.delete(doc.uri);
        })
    );

    // 定义服务器模块路径
    const serverModule = context.asAbsolutePath(path.join('out', 'language-server', 'server.js'));
    
    // 调试选项
    const debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] };
    
    // 服务器选项
    const serverOptions: ServerOptions = {
        run: { 
            module: serverModule, 
            transport: TransportKind.ipc 
        },
        debug: { 
            module: serverModule, 
            transport: TransportKind.ipc, 
            options: debugOptions 
        }
    };
    
    // 客户端选项
    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ 
            scheme: 'file', 
            language: 'vix' 
        }],
        synchronize: {
            fileEvents: workspace.createFileSystemWatcher('**/*.vix')
        }
    };
    
    // 创建语言客户端
    client = new LanguageClient(
        'vixLanguageServer',
        'Vix Language Server',
        serverOptions,
        clientOptions
    );
    
    // 启动客户端
    await client.start();
}

export function deactivate(): Thenable<void> | undefined {
    if (!client) {
        return undefined;
    }
    return client.stop();
}