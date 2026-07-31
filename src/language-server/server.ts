import {
    createConnection,
    TextDocuments,
    ProposedFeatures,
    InitializeParams,
    DidChangeConfigurationNotification,
    CompletionItem,
    CompletionList,
    TextDocumentPositionParams,
    TextDocumentSyncKind,
    InitializeResult,
    Diagnostic,
    DiagnosticSeverity,
    Range,
    DocumentDiagnosticParams,
    RelatedFullDocumentDiagnosticReport,
    FullDocumentDiagnosticReport,
    DocumentDiagnosticRequest,
    InlayHint,
    InlayHintKind,
    InlayHintParams,
    InlayHintRequest,
    HoverParams,
    Hover,
    CompletionItemKind,
    InsertTextFormat,
    DocumentSymbol,
    DocumentSymbolParams,
    SymbolKind,
    Location,
    ReferenceParams,
    DocumentHighlight,
    DocumentHighlightKind,
    RenameParams,
    TextEdit,
    Position
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

// 创建连接，用于与语言客户端通信
const connection = createConnection(ProposedFeatures.all);

// 文档集合，管理所有打开的文档
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);
let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;
let hasPullDiagnosticCapability = false;
type VixUILanguage = 'zh-cn' | 'en';

interface VixServerSettings {
    language: VixUILanguage;
}

const defaultSettings: VixServerSettings = { language: 'zh-cn' };
let globalSettings: VixServerSettings = defaultSettings;

function normalizeLanguage(value: unknown): VixUILanguage {
    if (value === 'en') {
        return 'en';
    }
    return 'zh-cn';
}

function t(zh: string, en: string): string {
    return globalSettings.language === 'en' ? en : zh;
}

async function refreshSettings(): Promise<void> {
    if (!hasConfigurationCapability) {
        globalSettings = defaultSettings;
        return;
    }

    const config = await connection.workspace.getConfiguration({ section: 'vix' }) as { language?: string } | undefined;
    globalSettings = {
        language: normalizeLanguage(config?.language)
    };
}

connection.onInitialize((params: InitializeParams) => {
    const capabilities = params.capabilities;

    // 检查客户端功能
    hasConfigurationCapability = !!(
        capabilities.workspace && !!capabilities.workspace.configuration
    );
    hasWorkspaceFolderCapability = !!(
        capabilities.workspace && !!capabilities.workspace.workspaceFolders
    );
    hasDiagnosticRelatedInformationCapability = !!(
        capabilities.textDocument &&
        capabilities.textDocument.publishDiagnostics &&
        capabilities.textDocument.publishDiagnostics.relatedInformation
    );
    hasPullDiagnosticCapability = !!(
        capabilities.textDocument &&
        (capabilities.textDocument as { diagnostic?: unknown }).diagnostic
    );

    const result: InitializeResult = {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            completionProvider: {
                triggerCharacters: ['.', ':']
            },
            // 只保留 pull diagnostics（Problems面板），不主动推送编辑器下划线
            diagnosticProvider: {
                documentSelector: [{ scheme: 'file', language: 'vix' }],
                interFileDependencies: false,
                workspaceDiagnostics: false
            },
            // 添加 hover 功能
            hoverProvider: true,
            inlayHintProvider: true,
            documentSymbolProvider: true,
            // Go to Definition
            definitionProvider: true,
            // Find References
            referencesProvider: true,
            // Document Highlights
            documentHighlightProvider: true,
            // Rename
            renameProvider: true
        }
    };
    
    return result;
});

connection.onInitialized(() => {
    if (hasConfigurationCapability) {
        connection.client.register(DidChangeConfigurationNotification.type, {
            section: 'vix'
        });
    }
    if (hasWorkspaceFolderCapability) {
        connection.workspace.onDidChangeWorkspaceFolders(_event => {
            connection.console.log('Workspace folder change event received.');
        });
    }

    refreshSettings().catch(error => {
        connection.console.error(`Failed to load vix settings: ${String(error)}`);
    });
});

connection.onDidChangeConfiguration(() => {
    refreshSettings().then(() => {
        if (!hasPullDiagnosticCapability) {
            documents.all().forEach(validateTextDocument);
        }
    }).catch(error => {
        connection.console.error(`Failed to refresh vix settings: ${String(error)}`);
    });
});

// 监听文档内容变化，执行诊断
documents.onDidChangeContent(change => {
    if (!hasPullDiagnosticCapability) {
        validateTextDocument(change.document);
    }
});

interface VixFunctionInfo {
    name: string;
    line: number;
    signature: string;
    genericParams: string[];
    params: Array<{ name: string; type?: string }>;
    returnType?: string;
}

interface VixVariableInfo {
    name: string;
    line: number;
    type?: string;
}

interface VixSymbolIndex {
    functions: Map<string, VixFunctionInfo>;
    variables: Map<string, VixVariableInfo>;
    structs: Map<string, { name: string; line: number; fields: Array<{ name: string; type?: string }> }>;
    maskedLines: string[];
}

const BUILTIN_TYPES = new Set(['i8', 'i16', 'i32', 'i64', 'u8', 'u16', 'u32', 'u64', 'f32', 'f64', 'string', 'char', 'bool', 'void']);
const BUILTIN_FUNCTIONS = new Set(['print', 'input', 'strlen', 'substr', 'printf', 'read', 'wait', 'parse', 'toint', 'tofloat', 'tostring', 'length', 'add', 'remove']);
const VIX_KEYWORDS = new Set(['if', 'while', 'for', 'return', 'extern', 'fn', 'mut', 'let', 'const', 'struct', 'obj', 'meth', 'field', 'impl', 'as', 'public', 'pub', 'elif', 'else', 'break', 'continue', 'in', 'import', 'mod', 'true', 'false', 'and', 'or', 'char', 'type', 'match']);

function parseGenericParams(genericText?: string): string[] {
    if (!genericText) {
        return [];
    }

    return genericText
        .split(',')
        .map(param => param.trim())
        .filter(param => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(param));
}

function buildFunctionInsertSnippet(fnInfo: VixFunctionInfo): string {
    const genericSnippet = fnInfo.genericParams.length > 0
        ? `:[${fnInfo.genericParams.map((param, index) => `\${${index + 1}:${param}}`).join(', ')}]`
        : '';

    const paramSnippetStart = fnInfo.genericParams.length + 1;
    const paramSnippet = fnInfo.params
        .map((param, index) => `\${${paramSnippetStart + index}:${param.name}}`)
        .join(', ');

    if (paramSnippet.length === 0) {
        return `${fnInfo.name}${genericSnippet}($0)`;
    }

    return `${fnInfo.name}${genericSnippet}(${paramSnippet})`;
}

function inferArrayLiteralInfo(expression: string, symbolIndex: VixSymbolIndex): { elementType: string; count: number } | undefined {
    const value = expression.trim();
    if (!value.startsWith('[') || !value.endsWith(']')) {
        return undefined;
    }

    const inner = value.slice(1, -1).trim();
    if (inner.length === 0) {
        return { elementType: 'unknown', count: 0 };
    }

    const entries = splitCallArguments(inner).map(entry => entry.value).filter(entry => entry.length > 0);
    if (entries.length === 0) {
        return { elementType: 'unknown', count: 0 };
    }

    const inferredTypes = entries
        .map(entry => inferExpressionType(entry, symbolIndex))
        .filter((entryType): entryType is string => !!entryType);

    const uniqueTypes = new Set(inferredTypes);
    const elementType = uniqueTypes.size === 1 ? inferredTypes[0] : 'unknown';
    return {
        elementType,
        count: entries.length
    };
}

function splitCallArguments(argsText: string): Array<{ value: string; offset: number }> {
    const result: Array<{ value: string; offset: number }> = [];
    let current = '';
    let currentStart = 0;
    let depth = 0;

    for (let index = 0; index < argsText.length; index++) {
        const char = argsText[index];
        if (char === '(' || char === '[' || char === '{') {
            depth++;
        } else if (char === ')' || char === ']' || char === '}') {
            depth = Math.max(0, depth - 1);
        }

        if (char === ',' && depth === 0) {
            if (current.trim().length > 0) {
                result.push({ value: current.trim(), offset: currentStart + current.indexOf(current.trim()) });
            }
            current = '';
            currentStart = index + 1;
            continue;
        }

        current += char;
    }

    if (current.trim().length > 0) {
        result.push({ value: current.trim(), offset: currentStart + current.indexOf(current.trim()) });
    }

    return result;
}

function getWordRangeAtPosition(line: string, character: number): { start: number; end: number; word: string } | null {
    if (!line) {
        return null;
    }

    let start = Math.min(character, line.length);
    let end = Math.min(character, line.length);

    while (start > 0 && /[a-zA-Z0-9_]/.test(line.charAt(start - 1))) {
        start--;
    }

    while (end < line.length && /[a-zA-Z0-9_]/.test(line.charAt(end))) {
        end++;
    }

    if (start === end) {
        return null;
    }

    return {
        start,
        end,
        word: line.substring(start, end)
    };
}

function maskLineForCode(line: string, state: { inBlockComment: boolean; inDoubleQuote: boolean; inSingleQuote: boolean; escaped: boolean }): string {
    const output = line.split('');

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        const nextChar = line[i + 1];

        if (state.inBlockComment) {
            output[i] = ' ';
            if (char === '*' && nextChar === '/') {
                output[i + 1] = ' ';
                state.inBlockComment = false;
                i++;
            }
            continue;
        }

        if (state.inDoubleQuote || state.inSingleQuote) {
            output[i] = ' ';
            if (state.escaped) {
                state.escaped = false;
                continue;
            }

            if (char === '\\') {
                state.escaped = true;
                continue;
            }

            if (state.inDoubleQuote && char === '"') {
                state.inDoubleQuote = false;
            } else if (state.inSingleQuote && char === '\'') {
                state.inSingleQuote = false;
            }
            continue;
        }

        if (char === '/' && nextChar === '/') {
            for (let j = i; j < line.length; j++) {
                output[j] = ' ';
            }
            break;
        }

        if (char === '/' && nextChar === '*') {
            output[i] = ' ';
            output[i + 1] = ' ';
            state.inBlockComment = true;
            i++;
            continue;
        }

        if (char === '"') {
            output[i] = ' ';
            state.inDoubleQuote = true;
            continue;
        }

        if (char === '\'') {
            output[i] = ' ';
            state.inSingleQuote = true;
            continue;
        }
    }

    return output.join('');
}

function buildSymbolIndex(document: TextDocument): VixSymbolIndex {
    const lines = document.getText().split('\n');
    const maskedLines: string[] = [];
    const functions = new Map<string, VixFunctionInfo>();
    const variables = new Map<string, VixVariableInfo>();
    const structs = new Map<string, { name: string; line: number; fields: Array<{ name: string; type?: string }> }>();

    const maskState = { inBlockComment: false, inDoubleQuote: false, inSingleQuote: false, escaped: false };
    let pendingStruct: { name: string; line: number; fields: Array<{ name: string; type?: string }> } | null = null;
    let activeStruct: { name: string; line: number; fields: Array<{ name: string; type?: string }> } | null = null;
    let structBraceDepth = 0;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex];
        const maskedLine = maskLineForCode(line, maskState);
        maskedLines.push(maskedLine);

        const fnRegex = /\bfn\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\s*:\s*\[([^\]]+)\])?\s*\(([^)]*)\)\s*(?::\s*([a-zA-Z_][a-zA-Z0-9_\[\]\*]*)|->\s*([a-zA-Z_][a-zA-Z0-9_\[\]\*]*))?/g;
        let fnMatch: RegExpExecArray | null;
        while ((fnMatch = fnRegex.exec(maskedLine)) !== null) {
            const fnName = fnMatch[1];
            const signature = lines[lineIndex].trim();
            const genericParams = parseGenericParams(fnMatch[2]);
            const params: Array<{ name: string; type?: string }> = [];
            if (!functions.has(fnName)) {
                functions.set(fnName, {
                    name: fnName,
                    line: lineIndex,
                    signature,
                    genericParams,
                    params,
                    returnType: fnMatch[4] || fnMatch[5]
                });
            }

            const paramsText = fnMatch[3] || '';
            const paramRegex = /\b(?:mut\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*([a-zA-Z_][a-zA-Z0-9_]*)?/g;
            let paramMatch: RegExpExecArray | null;
            while ((paramMatch = paramRegex.exec(paramsText)) !== null) {
                const paramName = paramMatch[1];
                const paramType = paramMatch[2];
                params.push({ name: paramName, type: paramType });
                if (!variables.has(paramName)) {
                    variables.set(paramName, {
                        name: paramName,
                        line: lineIndex,
                        type: paramType
                    });
                }
            }

            const existing = functions.get(fnName);
            if (existing) {
                existing.genericParams = genericParams;
                existing.params = params;
            }
        }

        const structMatch = /\bstruct\s+([a-zA-Z_][a-zA-Z0-9_]*)\b/.exec(maskedLine);
        if (structMatch) {
            const structName = structMatch[1];
            if (!structs.has(structName)) {
                structs.set(structName, { name: structName, line: lineIndex, fields: [] });
            }
            pendingStruct = structs.get(structName)!;
        }

        if (!activeStruct && pendingStruct && maskedLine.includes('{')) {
            activeStruct = pendingStruct;
            pendingStruct = null;
            structBraceDepth = 0;
        }

        if (activeStruct) {
            const fieldRegex = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*([a-zA-Z_][a-zA-Z0-9_]*)/g;
            let fieldMatch: RegExpExecArray | null;
            while ((fieldMatch = fieldRegex.exec(maskedLine)) !== null) {
                const fieldName = fieldMatch[1];
                const fieldType = fieldMatch[2];
                if (!activeStruct.fields.some(field => field.name === fieldName)) {
                    activeStruct.fields.push({ name: fieldName, type: fieldType });
                }
            }
        }

        for (const char of maskedLine) {
            if (char === '{') {
                structBraceDepth++;
            } else if (char === '}') {
                structBraceDepth--;
                if (activeStruct && structBraceDepth <= 0) {
                    activeStruct = null;
                    structBraceDepth = 0;
                }
            }
        }

        const declRegex = /\b(?:var|let|const)\s+(?:mut\s+)?([a-zA-Z_][a-zA-Z0-9_]*)(?:\s*:\s*([a-zA-Z_][a-zA-Z0-9_\[\]\*\s]+))?/g;
        let declMatch: RegExpExecArray | null;
        while ((declMatch = declRegex.exec(maskedLine)) !== null) {
            const name = declMatch[1];
            if (!variables.has(name)) {
                variables.set(name, { name, line: lineIndex, type: declMatch[2]?.trim() });
            }
        }

        const typedDeclRegex = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*([^=;]+?)\s*=/g;
        let typedDeclMatch: RegExpExecArray | null;
        while ((typedDeclMatch = typedDeclRegex.exec(maskedLine)) !== null) {
            const name = typedDeclMatch[1];
            if (!variables.has(name)) {
                variables.set(name, { name, line: lineIndex, type: typedDeclMatch[2].trim() });
            }
        }

        const assignmentRegex = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*=(?!=)/g;
        let assignmentMatch: RegExpExecArray | null;
        while ((assignmentMatch = assignmentRegex.exec(maskedLine)) !== null) {
            const name = assignmentMatch[1];
            if (!variables.has(name) && !VIX_KEYWORDS.has(name)) {
                variables.set(name, { name, line: lineIndex });
            }
        }

        const forIteratorRegex = /\bfor\s*(?:\(\s*)?([a-zA-Z_][a-zA-Z0-9_]*)\s+in\b/g;
        let forIteratorMatch: RegExpExecArray | null;
        while ((forIteratorMatch = forIteratorRegex.exec(maskedLine)) !== null) {
            const iteratorName = forIteratorMatch[1];
            if (!variables.has(iteratorName)) {
                variables.set(iteratorName, { name: iteratorName, line: lineIndex });
            }
        }
    }

    return { functions, variables, structs, maskedLines };
}

function createBlockRange(maskedLines: string[], sourceLines: string[], declarationLine: number): Range {
    let openBraceFound = false;
    let braceDepth = 0;

    for (let lineIndex = declarationLine; lineIndex < maskedLines.length; lineIndex++) {
        const line = maskedLines[lineIndex];
        for (let charIndex = 0; charIndex < line.length; charIndex++) {
            const char = line[charIndex];
            if (char === '{') {
                openBraceFound = true;
                braceDepth++;
                continue;
            }
            if (char === '}' && openBraceFound) {
                braceDepth--;
                if (braceDepth === 0) {
                    return {
                        start: { line: declarationLine, character: 0 },
                        end: { line: lineIndex, character: charIndex + 1 }
                    };
                }
            }
        }
    }

    const fallbackLine = sourceLines[declarationLine] ?? '';
    return {
        start: { line: declarationLine, character: 0 },
        end: { line: declarationLine, character: fallbackLine.length }
    };
}

function createSelectionRange(lineText: string, lineNumber: number, symbolName: string): Range {
    const symbolStart = Math.max(0, lineText.indexOf(symbolName));
    return {
        start: { line: lineNumber, character: symbolStart },
        end: { line: lineNumber, character: symbolStart + symbolName.length }
    };
}

function buildDocumentSymbols(document: TextDocument): DocumentSymbol[] {
    const symbolIndex = buildSymbolIndex(document);
    const sourceLines = document.getText().split('\n');
    const symbols: DocumentSymbol[] = [];

    const functions = [...symbolIndex.functions.values()].sort((left, right) => left.line - right.line);
    for (const fn of functions) {
        const lineText = sourceLines[fn.line] ?? '';
        const isExternDeclaration = isInExternBlock(fn.line, sourceLines) && !lineText.includes('{');
        const functionRange = isExternDeclaration
            ? {
                start: { line: fn.line, character: 0 },
                end: { line: fn.line, character: lineText.length }
            }
            : createBlockRange(symbolIndex.maskedLines, sourceLines, fn.line);
        symbols.push({
            name: fn.name,
            detail: fn.returnType ? `fn -> ${fn.returnType}` : 'fn',
            kind: SymbolKind.Function,
            range: functionRange,
            selectionRange: createSelectionRange(lineText, fn.line, fn.name)
        });
    }

    const structs = [...symbolIndex.structs.values()].sort((left, right) => left.line - right.line);
    for (const struct of structs) {
        const lineText = sourceLines[struct.line] ?? '';
        symbols.push({
            name: struct.name,
            detail: 'struct',
            kind: SymbolKind.Struct,
            range: createBlockRange(symbolIndex.maskedLines, sourceLines, struct.line),
            selectionRange: createSelectionRange(lineText, struct.line, struct.name)
        });
    }

    return symbols;
}

function countIdentifierUsages(maskedLines: string[], identifier: string): number {
    let count = 0;
    const regex = new RegExp(`\\b${identifier}\\b`, 'g');

    for (const line of maskedLines) {
        let match: RegExpExecArray | null;
        while ((match = regex.exec(line)) !== null) {
            count++;
        }
    }

    return count;
}

function isDeclarationAt(maskedLine: string, identifier: string, startIndex: number): boolean {
    const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
        new RegExp(`\\bfn\\s+${escaped}\\b`),
        new RegExp(`\\b(?:var|let|const)\\s+(?:mut\\s+)?${escaped}\\b`),
        new RegExp(`\\b${escaped}\\s*:\\s*[a-zA-Z_][a-zA-Z0-9_]*\\s*=`)
    ];

    return patterns.some(pattern => {
        const match = pattern.exec(maskedLine);
        if (!match || match.index === undefined) {
            return false;
        }
        const idIndex = maskedLine.indexOf(identifier, match.index);
        return idIndex === startIndex;
    });
}

function getPreviousSignificantChar(text: string): string {
    const trimmed = text.trimEnd();
    return trimmed.length > 0 ? trimmed[trimmed.length - 1] : '';
}

function endsWithArrow(text: string): boolean {
    return text.trimEnd().endsWith('->');
}

function isFunctionDeclarationInvocationLine(maskedLine: string, callMatch: RegExpExecArray): boolean {
    const declarationMatch = /^\s*(?:pub\s+)?fn\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\s*:\s*\[[^\]]+\])?\s*\(/.exec(maskedLine);
    if (!declarationMatch) {
        return false;
    }

    const declarationName = declarationMatch[1];
    const callName = callMatch[1];
    if (declarationName !== callName) {
        return false;
    }

    return maskedLine.indexOf(callName) === callMatch.index;
}

// 添加Hover处理器
connection.onHover((params: HoverParams): Hover | null => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
        return null;
    }

    const position = params.position;
    const text = document.getText();
    const lines = text.split('\n');
    const symbolIndex = buildSymbolIndex(document);
    
    // 获取光标所在行的内容
    const line = lines[position.line];
    if (!line) {
        return null;
    }

    const wordRange = getWordRangeAtPosition(line, position.character);
    if (!wordRange) {
        return null;
    }
    const { start, end, word } = wordRange;
    
    // 这里可以根据具体的Vix语言函数定义来返回相应信息
    // 为了演示，这里提供了一些示例函数的文档
    const functionDocs: { [key: string]: string } = {
        'if': t('条件语句: ```vix\nif (condition) { ... }\n```', 'Conditional statement: ```vix\nif (condition) { ... }\n```'),
        'while': t('循环语句: ```vix\nwhile (condition) { ... }\n```', 'Loop statement: ```vix\nwhile (condition) { ... }\n```'),
        'for': t('循环语句: ```vix\nfor (init; condition; increment) { ... }\n```', 'Loop statement: ```vix\nfor (init; condition; increment) { ... }\n```'),
        'print': t('输出函数: ```vix\nprint(value) - 输出指定值到控制台\n```', 'Output function: ```vix\nprint(value) - Print value to console\n```'),
        'input': t('#输入函数: ```vix\ninput() - 从控制台读取用户输入\n```', '#Input function: ```vix\ninput() - Read user input from console\n```'),
        'import': t('导入语句: ```vix\nimport module_name\n```\n用于导入模块。', 'Import statement: ```vix\nimport module_name\n```\nUsed to import a module.'),
    };

    if (functionDocs[word]) {
        return {
            contents: {
                kind: 'markdown',
                value: functionDocs[word]
            },
            range: {
                start: { line: position.line, character: start },
                end: { line: position.line, character: end }
            }
        };
    }

    const functionInfo = symbolIndex.functions.get(word);
    if (functionInfo) {
        const usageCount = countIdentifierUsages(symbolIndex.maskedLines, word);
        return {
            contents: {
                kind: 'markdown',
                value: t(
                    `### 函数 \`${word}\`\n\n\`\`\`vix\n${functionInfo.signature}\n\`\`\`\n\n- 定义位置: 第 ${functionInfo.line + 1} 行\n- 文档内引用次数: ${usageCount}`,
                    `### Function \`${word}\`\n\n\`\`\`vix\n${functionInfo.signature}\n\`\`\`\n\n- Defined at: line ${functionInfo.line + 1}\n- References in document: ${usageCount}`
                )
            },
            range: {
                start: { line: position.line, character: start },
                end: { line: position.line, character: end }
            }
        };
    }

    const variableInfo = symbolIndex.variables.get(word);
    if (variableInfo) {
        const usageCount = countIdentifierUsages(symbolIndex.maskedLines, word);
        const typeDisplay = variableInfo.type ? `\`${variableInfo.type}\`` : t('未知', 'unknown');
        return {
            contents: {
                kind: 'markdown',
                value: t(
                    `### 变量 \`${word}\`\n\n- 类型: ${typeDisplay}\n- 定义位置: 第 ${variableInfo.line + 1} 行\n- 文档内引用次数: ${usageCount}`,
                    `### Variable \`${word}\`\n\n- Type: ${typeDisplay}\n- Defined at: line ${variableInfo.line + 1}\n- References in document: ${usageCount}`
                )
            },
            range: {
                start: { line: position.line, character: start },
                end: { line: position.line, character: end }
            }
        };
    }

    const structInfo = symbolIndex.structs.get(word);
    if (structInfo) {
        const fieldText = structInfo.fields.length > 0
            ? structInfo.fields.map(field => `- ${field.name}: ${field.type ?? '未知'}`).join('\n')
            : '- (无字段)';
        return {
            contents: {
                kind: 'markdown',
                value: t(
                    `### 结构体 \`${word}\`\n\n- 定义位置: 第 ${structInfo.line + 1} 行\n\n字段:\n${fieldText}`,
                    `### Struct \`${word}\`\n\n- Defined at: line ${structInfo.line + 1}\n\nFields:\n${fieldText}`
                )
            },
            range: {
                start: { line: position.line, character: start },
                end: { line: position.line, character: end }
            }
        };
    }

    // 检查是否是内置类型
    if (BUILTIN_TYPES.has(word)) {
        return {
            contents: {
                kind: 'markdown',
                value: t(`内置类型: \`${word}\``, `Builtin type: \`${word}\``)
            },
            range: {
                start: { line: position.line, character: start },
                end: { line: position.line, character: end }
            }
        };
    }

    if (!VIX_KEYWORDS.has(word)) {
        return {
            contents: {
                kind: 'markdown',
                value: t(
                    `符号 \`${word}\` 未定义。\n\n请先声明变量或定义函数。`,
                    `Symbol \`${word}\` is undefined.\n\nPlease declare the variable or define the function first.`
                )
            },
            range: {
                start: { line: position.line, character: start },
                end: { line: position.line, character: end }
            }
        };
    }

    return null;
});

connection.onDocumentSymbol((params: DocumentSymbolParams): DocumentSymbol[] => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
        return [];
    }

    return buildDocumentSymbols(document);
});

// Go to Definition
connection.onDefinition((params: TextDocumentPositionParams): Location | null => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
        return null;
    }

    const lines = document.getText().split('\n');
    const line = lines[params.position.line];
    if (!line) {
        return null;
    }

    const wordRange = getWordRangeAtPosition(line, params.position.character);
    if (!wordRange) {
        return null;
    }

    const { word } = wordRange;
    const symbolIndex = buildSymbolIndex(document);

    const fnInfo = symbolIndex.functions.get(word);
    if (fnInfo) {
        const defLine = lines[fnInfo.line] ?? '';
        const charStart = defLine.indexOf(word);
        return {
            uri: params.textDocument.uri,
            range: {
                start: { line: fnInfo.line, character: Math.max(0, charStart) },
                end: { line: fnInfo.line, character: Math.max(0, charStart) + word.length }
            }
        };
    }

    const varInfo = symbolIndex.variables.get(word);
    if (varInfo) {
        const defLine = lines[varInfo.line] ?? '';
        const charStart = defLine.indexOf(word);
        return {
            uri: params.textDocument.uri,
            range: {
                start: { line: varInfo.line, character: Math.max(0, charStart) },
                end: { line: varInfo.line, character: Math.max(0, charStart) + word.length }
            }
        };
    }

    const structInfo = symbolIndex.structs.get(word);
    if (structInfo) {
        const defLine = lines[structInfo.line] ?? '';
        const charStart = defLine.indexOf(word);
        return {
            uri: params.textDocument.uri,
            range: {
                start: { line: structInfo.line, character: Math.max(0, charStart) },
                end: { line: structInfo.line, character: Math.max(0, charStart) + word.length }
            }
        };
    }

    return null;
});

// Find References
connection.onReferences((params: ReferenceParams): Location[] => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
        return [];
    }

    const lines = document.getText().split('\n');
    const line = lines[params.position.line];
    if (!line) {
        return [];
    }

    const wordRange = getWordRangeAtPosition(line, params.position.character);
    if (!wordRange) {
        return [];
    }

    const { word } = wordRange;
    if (VIX_KEYWORDS.has(word) || BUILTIN_TYPES.has(word) || BUILTIN_FUNCTIONS.has(word)) {
        return [];
    }

    const symbolIndex = buildSymbolIndex(document);
    const locations: Location[] = [];
    const regex = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');

    for (let lineIdx = 0; lineIdx < symbolIndex.maskedLines.length; lineIdx++) {
        const maskedLine = symbolIndex.maskedLines[lineIdx];
        let match: RegExpExecArray | null;
        while ((match = regex.exec(maskedLine)) !== null) {
            locations.push({
                uri: params.textDocument.uri,
                range: {
                    start: { line: lineIdx, character: match.index },
                    end: { line: lineIdx, character: match.index + word.length }
                }
            });
        }
    }

    return locations;
});

// Document Highlights
connection.onDocumentHighlight((params: TextDocumentPositionParams): DocumentHighlight[] => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
        return [];
    }

    const lines = document.getText().split('\n');
    const line = lines[params.position.line];
    if (!line) {
        return [];
    }

    const wordRange = getWordRangeAtPosition(line, params.position.character);
    if (!wordRange) {
        return [];
    }

    const { word } = wordRange;
    if (VIX_KEYWORDS.has(word) || BUILTIN_TYPES.has(word)) {
        return [];
    }

    const symbolIndex = buildSymbolIndex(document);
    const highlights: DocumentHighlight[] = [];
    const regex = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');

    for (let lineIdx = 0; lineIdx < symbolIndex.maskedLines.length; lineIdx++) {
        const maskedLine = symbolIndex.maskedLines[lineIdx];
        let match: RegExpExecArray | null;
        while ((match = regex.exec(maskedLine)) !== null) {
            const isWrite = isDeclarationAt(maskedLine, word, match.index);
            highlights.push({
                range: {
                    start: { line: lineIdx, character: match.index },
                    end: { line: lineIdx, character: match.index + word.length }
                },
                kind: isWrite ? DocumentHighlightKind.Write : DocumentHighlightKind.Read
            });
        }
    }

    return highlights;
});

// Rename
connection.onRenameRequest((params: RenameParams): { changes: { [uri: string]: TextEdit[] } } | null => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
        return null;
    }

    const lines = document.getText().split('\n');
    const line = lines[params.position.line];
    if (!line) {
        return null;
    }

    const wordRange = getWordRangeAtPosition(line, params.position.character);
    if (!wordRange) {
        return null;
    }

    const { word } = wordRange;
    const newName = params.newName;

    if (VIX_KEYWORDS.has(word) || BUILTIN_TYPES.has(word) || BUILTIN_FUNCTIONS.has(word)) {
        return null;
    }

    // Validate new name
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(newName)) {
        return null;
    }

    const symbolIndex = buildSymbolIndex(document);
    const edits: TextEdit[] = [];
    const regex = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');

    for (let lineIdx = 0; lineIdx < symbolIndex.maskedLines.length; lineIdx++) {
        const maskedLine = symbolIndex.maskedLines[lineIdx];
        let match: RegExpExecArray | null;
        while ((match = regex.exec(maskedLine)) !== null) {
            edits.push({
                range: {
                    start: { line: lineIdx, character: match.index },
                    end: { line: lineIdx, character: match.index + word.length }
                },
                newText: newName
            });
        }
    }

    return { changes: { [params.textDocument.uri]: edits } };
});

// 实现文档诊断请求处理器
connection.onRequest(DocumentDiagnosticRequest.type, (params: DocumentDiagnosticParams) => {
    const document = documents.get(params.textDocument.uri);
    
    if (!document) {
        return {
            kind: 'full',
            items: []
        } as FullDocumentDiagnosticReport;
    }
    
    const diagnostics = validateTextDocumentForDiagnostic(document);
    
    return {
        kind: 'full',
        items: diagnostics
    } as FullDocumentDiagnosticReport;
});

function inferExpressionType(expression: string, symbolIndex: VixSymbolIndex): string | undefined {
    const value = expression.trim();

    const arrayLiteralInfo = inferArrayLiteralInfo(value, symbolIndex);
    if (arrayLiteralInfo) {
        return `[${arrayLiteralInfo.elementType} * ${arrayLiteralInfo.count}]`;
    }

    if (/^'(?:\\.|[^\\'])'$/.test(value)) {
        return 'char';
    }

    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) {
        return 'string';
    }

    if (/^(true|false)$/.test(value)) {
        return 'bool';
    }

    if (/^[+-]?\d+$/.test(value)) {
        return 'i32';
    }

    if (/^[+-]?\d+\.\d+$/.test(value)) {
        return 'f64';
    }

    const structLiteralMatch = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*\{/.exec(value);
    if (structLiteralMatch && symbolIndex.structs.has(structLiteralMatch[1])) {
        return structLiteralMatch[1];
    }

    const functionCallMatch = /^([a-zA-Z_][a-zA-Z0-9_]*)(?:\s*:\s*\[[^\]]+\])?\s*\(/.exec(value);
    if (functionCallMatch) {
        const fnInfo = symbolIndex.functions.get(functionCallMatch[1]);
        if (fnInfo?.returnType) {
            return fnInfo.returnType;
        }
        if (functionCallMatch[1] === 'strlen' || functionCallMatch[1] === 'length') {
            return 'i32';
        }
    }

    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
        const variableInfo = symbolIndex.variables.get(value);
        if (variableInfo?.type) {
            return variableInfo.type;
        }
        if (symbolIndex.structs.has(value)) {
            return value;
        }
    }

    return undefined;
}

connection.onRequest(InlayHintRequest.type, (params: InlayHintParams): InlayHint[] => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
        return [];
    }

    const symbolIndex = buildSymbolIndex(document);
    const inlayHints: InlayHint[] = [];
    const startLine = params.range.start.line;
    const endLine = params.range.end.line;

    for (let lineIndex = startLine; lineIndex <= endLine && lineIndex < symbolIndex.maskedLines.length; lineIndex++) {
        const maskedLine = symbolIndex.maskedLines[lineIndex];

        const callRegex = /\b([a-zA-Z_][a-zA-Z0-9_]*)(?:\s*:\s*\[[^\]]*\])?\s*\(([^()]*)\)/g;
        let callMatch: RegExpExecArray | null;
        while ((callMatch = callRegex.exec(maskedLine)) !== null) {
            if (isFunctionDeclarationInvocationLine(maskedLine, callMatch)) {
                continue;
            }

            const functionName = callMatch[1];
            const argsText = callMatch[2];
            const functionInfo = symbolIndex.functions.get(functionName);
            if (!functionInfo || functionInfo.params.length === 0) {
                continue;
            }

            const argsStartInMatch = callMatch[0].indexOf(argsText);
            const args = splitCallArguments(argsText);
            const argCount = Math.min(args.length, functionInfo.params.length);

            for (let argIndex = 0; argIndex < argCount; argIndex++) {
                const paramName = functionInfo.params[argIndex].name;
                const argOffset = args[argIndex].offset;
                inlayHints.push({
                    position: {
                        line: lineIndex,
                        character: callMatch.index + argsStartInMatch + argOffset
                    },
                    label: `${paramName}: `,
                    kind: InlayHintKind.Parameter
                });
            }
        }

        const assignmentRegex = /\b(?:(?:(?:var|let|const)\s+)?(?:mut\s+)?)?([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*([^;]+)/g;
        let assignMatch: RegExpExecArray | null;
        while ((assignMatch = assignmentRegex.exec(maskedLine)) !== null) {
            const variableName = assignMatch[1];
            const expressionText = assignMatch[2];
            const variableInfo = symbolIndex.variables.get(variableName);

            if (variableInfo?.type) {
                continue;
            }

            const inferredType = inferExpressionType(expressionText, symbolIndex);
            if (!inferredType) {
                continue;
            }

            const variableStart = maskedLine.indexOf(variableName, assignMatch.index);
            if (variableStart < 0) {
                continue;
            }

            inlayHints.push({
                position: {
                    line: lineIndex,
                    character: variableStart + variableName.length
                },
                label: `: ${inferredType}`,
                kind: InlayHintKind.Type
            });
        }

        const typedArrayRegex = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*\[\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\*\s*(\d+|[a-zA-Z_][a-zA-Z0-9_]*)\s*\]\s*=\s*(\[[^\]]*\])/g;
        let typedArrayMatch: RegExpExecArray | null;
        while ((typedArrayMatch = typedArrayRegex.exec(maskedLine)) !== null) {
            const variableName = typedArrayMatch[1];
            const expectedElementType = typedArrayMatch[2];
            const expectedCountText = typedArrayMatch[3];
            const literalText = typedArrayMatch[4];
            const arrayInfo = inferArrayLiteralInfo(literalText, symbolIndex);
            if (!arrayInfo) {
                continue;
            }

            const literalStart = maskedLine.indexOf(literalText, typedArrayMatch.index);
            if (literalStart < 0) {
                continue;
            }

            inlayHints.push({
                position: {
                    line: lineIndex,
                    character: literalStart
                },
                label: `📏 ${arrayInfo.count}/${expectedCountText}`,
                kind: InlayHintKind.Type
            });

            if (arrayInfo.elementType !== 'unknown' && arrayInfo.elementType !== expectedElementType) {
                inlayHints.push({
                    position: {
                        line: lineIndex,
                        character: literalStart
                    },
                    label: `⚠ ${arrayInfo.elementType}: ${expectedElementType}`,
                    kind: InlayHintKind.Type
                });
            }

            const variableStart = maskedLine.indexOf(variableName, typedArrayMatch.index);
            if (variableStart >= 0) {
                inlayHints.push({
                    position: {
                        line: lineIndex,
                        character: variableStart + variableName.length
                    },
                    label: `: [${expectedElementType} * ${expectedCountText}]`,
                    kind: InlayHintKind.Type
                });
            }
        }
    }

    return inlayHints;
});

// 验证文档内容并发送诊断信息
function validateTextDocument(textDocument: TextDocument): void {
    // 不主动推送诊断（publishDiagnostics），只依赖 pull diagnostics（diagnosticProvider）
    // 这样诊断只出现在 Problems 面板，不会在编辑器中产生下划线
}

function scanQuoteState(line: string): { hasUnclosedDouble: boolean; hasUnclosedSingle: boolean } {
    let inDoubleQuote = false;
    let inSingleQuote = false;
    let escaped = false;

    for (let index = 0; index < line.length; index++) {
        const char = line[index];
        const nextChar = line[index + 1];

        if (!inDoubleQuote && !inSingleQuote && char === '/' && nextChar === '/') {
            break;
        }

        if (escaped) {
            escaped = false;
            continue;
        }

        if (char === '\\') {
            escaped = true;
            continue;
        }

        if (!inSingleQuote && char === '"') {
            inDoubleQuote = !inDoubleQuote;
            continue;
        }

        if (!inDoubleQuote && char === '\'') {
            inSingleQuote = !inSingleQuote;
        }
    }

    return {
        hasUnclosedDouble: inDoubleQuote,
        hasUnclosedSingle: inSingleQuote
    };
}

// 验证文档内容并返回诊断信息
// 添加对extern块的支持和改进字符串解析
function validateTextDocumentForDiagnostic(textDocument: TextDocument): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const uniqueDiagnosticKeys = new Set<string>();
    const pushUniqueDiagnostic = (diagnostic: Diagnostic): void => {
        const key = `${diagnostic.range.start.line}:${diagnostic.range.start.character}:${diagnostic.message}`;
        if (uniqueDiagnosticKeys.has(key)) {
            return;
        }
        uniqueDiagnosticKeys.add(key);
        diagnostics.push(diagnostic);
    };
    
    const text = textDocument.getText();
    const lines = text.split('\n');
    const symbolIndex = buildSymbolIndex(textDocument);
    const functionScopes = [...symbolIndex.functions.values()]
        .map(fn => {
            const functionRange = createBlockRange(symbolIndex.maskedLines, lines, fn.line);
            return {
                name: fn.name,
                startLine: fn.line,
                endLine: functionRange.end.line
            };
        })
        .sort((left, right) => left.startLine - right.startLine);
    const seenVariableDeclarations = new Map<string, number>();
    
    // 全局语法检查 - 括号匹配（忽略字符串、字符字面量和注释中的括号）
    const bracketStack: { char: string; line: number; col: number; fullLine: string }[] = [];
    const closingToOpening: Record<string, string> = {
        ')': '(',
        ']': '[',
        '}': '{'
    };
    const closingNameMap: Record<string, string> = {
        ')': '右小括号',
        ']': '右方括号',
        '}': '右花括号'
    };

    let inBlockComment = false;
    let inDoubleQuote = false;
    let inSingleQuote = false;
    let escaped = false;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        let inLineComment = false;

        for (let colIdx = 0; colIdx < line.length; colIdx++) {
            const char = line[colIdx];
            const nextChar = line[colIdx + 1];

            if (inLineComment) {
                break;
            }

            if (inBlockComment) {
                if (char === '*' && nextChar === '/') {
                    inBlockComment = false;
                    colIdx++;
                }
                continue;
            }

            if (!inDoubleQuote && !inSingleQuote && char === '/' && nextChar === '/') {
                inLineComment = true;
                continue;
            }

            if (!inDoubleQuote && !inSingleQuote && char === '/' && nextChar === '*') {
                inBlockComment = true;
                colIdx++;
                continue;
            }

            if (escaped) {
                escaped = false;
                continue;
            }

            if (inDoubleQuote || inSingleQuote) {
                if (char === '\\') {
                    escaped = true;
                    continue;
                }

                if (inDoubleQuote && char === '"') {
                    inDoubleQuote = false;
                } else if (inSingleQuote && char === '\'') {
                    inSingleQuote = false;
                }
                continue;
            }

            if (char === '"') {
                inDoubleQuote = true;
                continue;
            }

            if (char === '\'') {
                inSingleQuote = true;
                continue;
            }

            if (char === '(' || char === '[' || char === '{') {
                bracketStack.push({ char, line: lineIdx, col: colIdx, fullLine: line });
                continue;
            }

            if (char === ')' || char === ']' || char === '}') {
                const expectedOpening = closingToOpening[char];
                const top = bracketStack[bracketStack.length - 1];

                if (!top || top.char !== expectedOpening) {
                    pushUniqueDiagnostic({
                        severity: DiagnosticSeverity.Error,
                        range: {
                            start: { line: lineIdx, character: colIdx },
                            end: { line: lineIdx, character: colIdx + 1 }
                        },
                        message: t(
                            `多余的${closingNameMap[char]}在第 ${lineIdx + 1} 行`,
                            `Unexpected '${char}' at line ${lineIdx + 1}`
                        ),
                        source: 'vix'
                    });
                } else {
                    bracketStack.pop();
                }
            }
        }
    }

    // 检查未闭合的括号
    while (bracketStack.length > 0) {
        const unmatched = bracketStack.pop()!;

        if (unmatched.char === '(' && /\bfn\s+\w+\s*\([^)]*$/.test(unmatched.fullLine.trim())) {
            continue;
        }

        pushUniqueDiagnostic({
            severity: DiagnosticSeverity.Error,
            range: {
                start: { line: unmatched.line, character: unmatched.col },
                end: { line: unmatched.line, character: unmatched.col + 1 }
            },
            message: t(
                `未闭合的 ${unmatched.char} 在第 ${unmatched.line + 1} 行`,
                `Unclosed '${unmatched.char}' at line ${unmatched.line + 1}`
            ),
            source: 'vix'
        });
    }
    
    // 逐行检查
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // 检查未闭合的字符串/字符字面量
        const quoteState = scanQuoteState(line);
        
        if (quoteState.hasUnclosedDouble) {
            // 检查是否在extern块内，extern块内的函数声明不需要严格检查字符串内容
            if (!isInExternBlock(i, lines)) {
                pushUniqueDiagnostic({
                    severity: DiagnosticSeverity.Error,
                    range: {
                        start: { line: i, character: 0 },
                        end: { line: i, character: line.length }
                    },
                    message: t(`未闭合的字符串在第 ${i + 1} 行`, `Unclosed string at line ${i + 1}`),
                    source: 'vix'
                });
            }
        }
        
        if (quoteState.hasUnclosedSingle) {
            if (!isInExternBlock(i, lines)) {
                pushUniqueDiagnostic({
                    severity: DiagnosticSeverity.Error,
                    range: {
                        start: { line: i, character: 0 },
                        end: { line: i, character: line.length }
                    },
                    message: t(`未闭合的字符在第 ${i + 1} 行`, `Unclosed char literal at line ${i + 1}`),
                    source: 'vix'
                });
            }
        }
        
        // 更精确地检查语法错误：以数字开头的标识符（排除纯数字）
        // 使用正则表达式匹配以数字开头的标识符，但排除独立的数字
        const tokens = line.split(/(\s+|[(),=+\-*\/{}\[\];])/);
        const maskedLine = symbolIndex.maskedLines[i] || line;
        for (const token of tokens) {
            if (!token) continue;

            // 排除常见数字字面量：十六进制/bin/oct（0x/0b/0o）、小数、整数、以及带符号的数字
            const numericLiteralRegex = /^[-+]?(?:0x[0-9A-Fa-f]+|0b[01]+|0o[0-7]+|\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)$/;
            if (numericLiteralRegex.test(token)) {
                continue;
            }

            // 检查是否是以数字开头的标识符（例如 1var, 2foo, 0xFF 已被上面排除）
            if (/^\d[\w]*$/.test(token) && /[a-zA-Z_]/.test(token)) {
                const startPos = line.indexOf(token);

                // 如果 token 在赋值号右侧，则忽略（例如 let hax = 0xFF 中的 0xFF）
                let assignIdx = maskedLine.indexOf('=');
                let isRightOfAssign = false;
                while (assignIdx !== -1 && assignIdx < startPos) {
                    const before = maskedLine[assignIdx - 1] || '';
                    const after = maskedLine[assignIdx + 1] || '';
                    // 排除 ==, !=, <=, >=, =>, -> 等情况
                    if (before !== '=' && after !== '=' && before !== '!' && before !== '<' && before !== '>' && before !== '-') {
                        isRightOfAssign = true;
                        break;
                    }
                    assignIdx = maskedLine.indexOf('=', assignIdx + 1);
                }

                if (isRightOfAssign) {
                    continue;
                }

                const diagnostic: Diagnostic = {
                    severity: DiagnosticSeverity.Error,
                    range: {
                        start: { line: i, character: startPos },
                        end: { line: i, character: startPos + token.length }
                    },
                    message: t(
                        `标识符不能以数字开头: "${token}"`,
                        `Identifier cannot start with a number: "${token}"`
                    ),
                    source: 'vix'
                };
                pushUniqueDiagnostic(diagnostic);
            }
        }
        
        // 检查重复的变量声明（按函数作用域隔离）
        const varDeclarationPattern = /\b(var|let|const)\s+(?:mut\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\b/g;
        let varMatch: RegExpExecArray | null;
        while ((varMatch = varDeclarationPattern.exec(maskedLine)) !== null) {
            const varName = varMatch[2];
            const currentScope = functionScopes.find(scope => i >= scope.startLine && i <= scope.endLine);
            const scopeKey = currentScope ? `fn:${currentScope.startLine}-${currentScope.endLine}` : 'global';
            const declarationKey = `${scopeKey}:${varName}`;

            if (seenVariableDeclarations.has(declarationKey)) {
                const diagnostic: Diagnostic = {
                    severity: DiagnosticSeverity.Warning,
                    range: {
                        start: { line: i, character: varMatch.index },
                        end: { line: i, character: varMatch.index + varMatch[0].length }
                    },
                    message: t(`变量 "${varName}" 已经被声明`, `Variable "${varName}" is already declared`),
                    source: 'vix'
                };
                pushUniqueDiagnostic(diagnostic);
                continue;
            }

            seenVariableDeclarations.set(declarationKey, i);
        }
        
    }

    return diagnostics;
}

// 辅助函数：判断某一行是否在extern块内部
function isInExternBlock(lineIndex: number, lines: string[]): boolean {
    let braceDepth = 0;
    let inExtern = false;
    
    for (let i = 0; i <= lineIndex; i++) {
        const line = lines[i];
        
        // 检查是否进入extern块
        if (/\bextern\s+"[^"]*"\s*\{/.test(line)) {
            inExtern = true;
        }
        
        // 计算括号深度
        for (const char of line) {
            if (char === '{') {
                braceDepth++;
            } else if (char === '}') {
                braceDepth--;
                // 如果深度归零，说明extern块结束
                if (braceDepth === 0 && inExtern) {
                    inExtern = false;
                }
            }
        }
    }
    
    return inExtern;
}

// 额外的辅助函数：提取文档中的变量和函数定义
function extractSymbolsFromDocument(document: TextDocument) {
    const symbolIndex = buildSymbolIndex(document);
    const symbols: CompletionItem[] = [];

    for (const fnInfo of symbolIndex.functions.values()) {
        symbols.push({
            label: fnInfo.name,
            kind: CompletionItemKind.Function,
            detail: fnInfo.genericParams.length > 0
                ? t(`泛型函数 ${fnInfo.name}:[${fnInfo.genericParams.join(', ')}]`, `Generic function ${fnInfo.name}:[${fnInfo.genericParams.join(', ')}]`)
                : t(`函数 ${fnInfo.name}`, `Function ${fnInfo.name}`),
            insertText: buildFunctionInsertSnippet(fnInfo),
            insertTextFormat: InsertTextFormat.Snippet
        });
    }

    for (const variableInfo of symbolIndex.variables.values()) {
        symbols.push({
            label: variableInfo.name,
            kind: CompletionItemKind.Variable,
            detail: variableInfo.type
                ? t(`变量 ${variableInfo.name}: ${variableInfo.type}`, `Variable ${variableInfo.name}: ${variableInfo.type}`)
                : t(`变量 ${variableInfo.name}`, `Variable ${variableInfo.name}`)
        });
    }

    for (const structInfo of symbolIndex.structs.values()) {
        symbols.push({
            label: structInfo.name,
            kind: CompletionItemKind.Class,
            detail: t(`结构体 ${structInfo.name}`, `Struct ${structInfo.name}`)
        });
    }
    
    return symbols;
}

// 处理代码补全请求
connection.onCompletion(
    (_textDocumentPosition: TextDocumentPositionParams): CompletionList => {
        // 获取当前文档
        const document = documents.get(_textDocumentPosition.textDocument.uri);
        if (!document) {
            return { isIncomplete: false, items: [] };
        }

        // 当前行的内容
        const position = _textDocumentPosition.position;
        const line = document.getText({
            start: { line: position.line, character: 0 },
            end: { line: position.line, character: position.character }
        });

        // 根据上下文提供不同的补全建议
        let items: CompletionItem[] = [];
        
        // 提取文档中的符号
        const documentSymbols = extractSymbolsFromDocument(document);
        
        // 如果行以空格开头，可能是在写控制结构
        if (/^\s*$/.test(line)) {
            items = [
                {
                    label: 'extern',
                    kind: CompletionItemKind.Keyword,
                    detail: t('外部链接声明', 'External linkage declaration')
                },
                {
                    label: 'if',
                    kind: CompletionItemKind.Keyword,
                    detail: t('条件语句', 'Conditional statement')
                },
                {
                    label: 'while',
                    kind: CompletionItemKind.Keyword,
                    detail: t('循环语句', 'Loop statement')
                },
                {
                    label: 'for',
                    kind: CompletionItemKind.Keyword,
                    detail: t('循环语句', 'Loop statement')
                },
                {
                    label: 'fn',
                    kind: CompletionItemKind.Keyword,
                    detail: t('函数定义', 'Function definition')
                },
                {
                    label: 'struct',
                    kind: CompletionItemKind.Keyword,
                    detail: t('结构体定义', 'Struct definition')
                },
                {
                    label: 'mod',
                    kind: CompletionItemKind.Keyword,
                    detail: t('模块声明', 'Module declaration'),
                    insertText: 'mod ${1:name}',
                    insertTextFormat: InsertTextFormat.Snippet
                },
                {
                    label: 'mut',
                    kind: CompletionItemKind.Keyword,
                    detail: t('可变变量声明', 'Mutable variable declaration')
                },
                {
                    label: 'let',
                    kind: CompletionItemKind.Keyword,
                    detail: t('变量声明 (let)', 'Variable declaration (let)')
                },
                {
                    label: 'return',
                    kind: CompletionItemKind.Keyword,
                    detail: t('返回语句', 'Return statement')
                },
                {
                    label: 'type',
                    kind: CompletionItemKind.Keyword,
                    detail: t('类型别名定义', 'Type alias definition'),
                    insertText: 'type ${1:Name} = ${2:Variant1} | ${3:Variant2}',
                    insertTextFormat: InsertTextFormat.Snippet
                },
                {
                    label: 'match',
                    kind: CompletionItemKind.Keyword,
                    detail: t('模式匹配语句', 'Pattern matching statement'),
                    insertText: 'match ${1:value} {\n\t${2:Case1} -> {\n\t\t${3}\n\t},\n\t_ -> {\n\t\t$0\n\t}\n}',
                    insertTextFormat: InsertTextFormat.Snippet
                }
            ];
        } else if (line.endsWith('.')) {
            // 如果用户输入了点号，则提供属性/方法补全
            items = [
                {
                    label: 'property1',
                    kind: CompletionItemKind.Field,
                    detail: t('示例属性1', 'Example property 1')
                },
                {
                    label: 'method1()',
                    kind: CompletionItemKind.Method,
                    detail: t('示例方法1', 'Example method 1')
                }
            ];
        } else {
            // 根据当前输入的前缀过滤补全项
            const prefix = line.split(/\W+/).pop() || '';
            
            // 检查是否是关键字补全
            const keywords = [
                { label: 'extern', kind: CompletionItemKind.Keyword, detail: t('外部链接声明', 'External linkage declaration') },
                { label: 'if', kind: CompletionItemKind.Keyword, detail: t('条件语句', 'Conditional statement') },
                { label: 'while', kind: CompletionItemKind.Keyword, detail: t('循环语句', 'Loop statement') },
                { label: 'for', kind: CompletionItemKind.Keyword, detail: t('循环语句', 'Loop statement') },
                { label: 'fn', kind: CompletionItemKind.Keyword, detail: t('函数定义', 'Function definition') },
                { label: 'struct', kind: CompletionItemKind.Keyword, detail: t('结构体定义', 'Struct definition') },
                {
                    label: 'mod',
                    kind: CompletionItemKind.Keyword,
                    detail: t('模块声明', 'Module declaration'),
                    insertText: 'mod ${1:name}',
                    insertTextFormat: InsertTextFormat.Snippet
                },
                { label: 'mut', kind: CompletionItemKind.Keyword, detail: t('可变变量声明', 'Mutable variable declaration') },
                { label: 'let', kind: CompletionItemKind.Keyword, detail: t('变量声明 (let)', 'Variable declaration (let)') },
                { label: 'return', kind: CompletionItemKind.Keyword, detail: t('返回语句', 'Return statement') },
                { label: 'else', kind: CompletionItemKind.Keyword, detail: t('条件分支', 'Conditional branch') },
                { label: 'elif', kind: CompletionItemKind.Keyword, detail: t('条件分支', 'Conditional branch') },
                { label: 'true', kind: CompletionItemKind.Value, detail: t('布尔值', 'Boolean value') },
                { label: 'false', kind: CompletionItemKind.Value, detail: t('布尔值', 'Boolean value') },
                { label: 'obj', kind: CompletionItemKind.Keyword, detail: t('对象定义', 'Object definition') },
                { label: 'impl', kind: CompletionItemKind.Keyword, detail: t('实现块', 'Implementation block') },
                { label: 'as', kind: CompletionItemKind.Keyword, detail: t('类型转换', 'Type conversion') },
                { label: 'public', kind: CompletionItemKind.Keyword, detail: t('公共访问修饰符', 'Public access modifier') },
                { label: 'in', kind: CompletionItemKind.Keyword, detail: t('循环中的成员操作符', 'Member operator in loop') },
                { label: 'break', kind: CompletionItemKind.Keyword, detail: t('跳出循环', 'Break loop') },
                { label: 'continue', kind: CompletionItemKind.Keyword, detail: t('继续下一次循环', 'Continue next iteration') },
                {
                    label: 'type',
                    kind: CompletionItemKind.Keyword,
                    detail: t('类型别名定义', 'Type alias definition'),
                    insertText: 'type ${1:Name} = ${2:Variant1} | ${3:Variant2}',
                    insertTextFormat: InsertTextFormat.Snippet
                },
                {
                    label: 'match',
                    kind: CompletionItemKind.Keyword,
                    detail: t('模式匹配语句', 'Pattern matching statement'),
                    insertText: 'match ${1:value} {\n\t${2:Case1} -> {\n\t\t${3}\n\t},\n\t_ -> {\n\t\t$0\n\t}\n}',
                    insertTextFormat: InsertTextFormat.Snippet
                }
            ];
            
            // 类型补全
            const types = [
                { label: 'i8', kind: CompletionItemKind.TypeParameter, detail: t('8位有符号整数', '8-bit signed integer') },
                { label: 'i16', kind: CompletionItemKind.TypeParameter, detail: t('16位有符号整数', '16-bit signed integer') },
                { label: 'i32', kind: CompletionItemKind.TypeParameter, detail: t('32位有符号整数', '32-bit signed integer') },
                { label: 'i64', kind: CompletionItemKind.TypeParameter, detail: t('64位有符号整数', '64-bit signed integer') },
                { label: 'u8', kind: CompletionItemKind.TypeParameter, detail: t('8位无符号整数', '8-bit unsigned integer') },
                { label: 'u16', kind: CompletionItemKind.TypeParameter, detail: t('16位无符号整数', '16-bit unsigned integer') },
                { label: 'u32', kind: CompletionItemKind.TypeParameter, detail: t('32位无符号整数', '32-bit unsigned integer') },
                { label: 'u64', kind: CompletionItemKind.TypeParameter, detail: t('64位无符号整数', '64-bit unsigned integer') },
                { label: 'f32', kind: CompletionItemKind.TypeParameter, detail: t('32位浮点数', '32-bit floating point') },
                { label: 'f64', kind: CompletionItemKind.TypeParameter, detail: t('64位浮点数', '64-bit floating point') },
                { label: 'string', kind: CompletionItemKind.TypeParameter, detail: t('字符串类型', 'String type') },
                { label: 'char', kind: CompletionItemKind.TypeParameter, detail: t('字符类型', 'Char type') },
                { label: 'bool', kind: CompletionItemKind.TypeParameter, detail: t('布尔类型', 'Boolean type') },
                { label: 'void', kind: CompletionItemKind.TypeParameter, detail: t('空类型', 'Void type') }
            ];
            
            // 预定义函数补全
            const functions = [
                {
                    label: 'print',
                    kind: CompletionItemKind.Function, // Function
                    detail: t('输出函数', 'Output function'),
                    insertText: 'print(${1:value})',
                    insertTextFormat: InsertTextFormat.Snippet
                },
                {
                    label: 'input',
                    kind: CompletionItemKind.Function, // Function
                    detail: t('输入函数', 'Input function'),
                    insertText: 'input()',
                    insertTextFormat: InsertTextFormat.Snippet
                },
                {
                    label: 'strlen',
                    kind: CompletionItemKind.Function, // Function
                    detail: t('字符串长度函数', 'String length function'),
                    insertText: 'strlen(${1:str})',
                    insertTextFormat: InsertTextFormat.Snippet
                },
                {
                    label: 'substr',
                    kind: CompletionItemKind.Function, // Function
                    detail: t('子字符串函数', 'Substring function'),
                    insertText: 'substr(${1:str}, ${2:start}, ${3:length})',
                    insertTextFormat: InsertTextFormat.Snippet
                }
            ];
            
            // 合并所有补全项，优先显示文档中的符号
            items = [
                ...documentSymbols.filter(sym => sym.label.startsWith(prefix)),
                ...keywords.filter(kw => kw.label.startsWith(prefix)),
                ...types.filter(ty => ty.label.startsWith(prefix)),
                ...functions.filter(func => func.label.startsWith(prefix))
            ];
        }

        return { isIncomplete: false, items };
    }
);

// 监听连接关闭事件
connection.onDidChangeWatchedFiles(_change => {
    connection.console.log(t('我们监视的文件已更改', 'Watched files have changed'));
});

// 监听文档同步请求
documents.listen(connection);

// 监听连接
connection.listen();