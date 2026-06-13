import {
    createConnection,
    TextDocuments,
    TextDocumentSyncKind,
    ProposedFeatures,
    CompletionItem,
    CompletionItemKind,
    Diagnostic,
    DiagnosticSeverity,
    InitializeParams,
    TextDocumentPositionParams,
    DidChangeConfigurationNotification
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

// 创建连接
const connection = createConnection(ProposedFeatures.all);

// 创建文档管理器
const documents = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

connection.onInitialize((params: InitializeParams) => {
    const capabilities = params.capabilities;

    // 检查客户端是否支持配置功能
    hasConfigurationCapability = !!(
        capabilities.workspace && !!capabilities.workspace.configuration
    );
    // 检查客户端是否支持工作区文件夹功能
    hasWorkspaceFolderCapability = !!(
        capabilities.workspace && !!capabilities.workspace.workspaceFolders
    );
    // 检查客户端是否支持相关诊断信息
    hasDiagnosticRelatedInformationCapability = !!(
        capabilities.textDocument &&
        capabilities.textDocument.publishDiagnostics &&
        capabilities.textDocument.publishDiagnostics.relatedInformation
    );

    return {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            completionProvider: {
                resolveProvider: true,
                triggerCharacters: ['.']
            },
            diagnosticProvider: {
                documentSelector: [{ scheme: 'file', language: 'vix' }],
                interFileDependencies: false,
                workspaceDiagnostics: false
            }
        }
    };
});

connection.onInitialized(() => {
    if (hasConfigurationCapability) {
        connection.client.register(DidChangeConfigurationNotification.type, {
            section: 'vix'
        });
    }
    if (hasWorkspaceFolderCapability) {
        connection.workspace.onDidChangeWorkspaceFolders((_event) => {
            connection.console.log('Workspace folder change event received.');
        });
    }
});

// 存储文档设置
const documentSettings: Map<string, Thenable<any>> = new Map();

// 重置所有文档设置
connection.onDidChangeConfiguration((change) => {
    if (hasConfigurationCapability) {
        documentSettings.clear();
    } else {
        documentSettings.set('*', Promise.resolve(change.settings));
    }

    // 重新验证所有打开的文档
    documents.all().forEach(validateTextDocument);
});

// 仅当客户端不支持文档设置时才使用全局设置
function getDocumentSettings(resource: string): Thenable<any> {
    if (!hasConfigurationCapability) {
        return Promise.resolve(documentSettings.get('*'));
    }
    let result = documentSettings.get(resource);
    if (!result) {
        result = connection.workspace.getConfiguration({
            scopeUri: resource,
            section: 'vix'
        });
        documentSettings.set(resource, result);
    }
    return result;
}

function maskLineForCode(
    line: string,
    state: { inBlockComment: boolean; inDoubleQuote: boolean; inSingleQuote: boolean; escaped: boolean }
): string {
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

// 监听文档变化并验证
documents.onDidOpen(change => {
    validateTextDocument(change.document);
});

documents.onDidChangeContent(change => {
    validateTextDocument(change.document);
});

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
    const diagnostics: Diagnostic[] = [];

    // 获取文档内容
    const text = textDocument.getText();
    const lines = text.split(/\r?\n/g);
    const maskState = { inBlockComment: false, inDoubleQuote: false, inSingleQuote: false, escaped: false };
    let doubleQuoteStart: { line: number; character: number } | null = null;
    let singleQuoteStart: { line: number; character: number } | null = null;

    // 遍历每一行检查错误
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const maskedLine = maskLineForCode(line, maskState);
        
        // 检查一些常见的错误模式
        const errorIndex = maskedLine.toLowerCase().indexOf('error');
        if (errorIndex !== -1) {
            diagnostics.push(
                Diagnostic.create(
                    { start: { line: i, character: errorIndex }, 
                      end: { line: i, character: errorIndex + 5 } },
                    'Found error keyword in line',
                    DiagnosticSeverity.Error,
                    100,
                    'VixChecker'
                )
            );
        }
        
        // 检查语法错误：未闭合的括号
        const openParen = (maskedLine.match(/\(/g) || []).length;
        const closeParen = (maskedLine.match(/\)/g) || []).length;
        if (openParen > closeParen) {
            diagnostics.push(
                Diagnostic.create(
                    { start: { line: i, character: 0 }, 
                      end: { line: i, character: maskedLine.length } },
                    'Unmatched parentheses',
                    DiagnosticSeverity.Warning,
                    101,
                    'VixChecker'
                )
            );
        }

        if (maskState.inDoubleQuote && doubleQuoteStart === null) {
            doubleQuoteStart = { line: i, character: 0 };
        }

        if (maskState.inSingleQuote && singleQuoteStart === null) {
            singleQuoteStart = { line: i, character: 0 };
        }

        if (!maskState.inDoubleQuote) {
            doubleQuoteStart = null;
        }

        if (!maskState.inSingleQuote) {
            singleQuoteStart = null;
        }
    }

    if (maskState.inDoubleQuote && doubleQuoteStart) {
        diagnostics.push(
            Diagnostic.create(
                {
                    start: doubleQuoteStart,
                    end: { line: lines.length - 1, character: lines[lines.length - 1]?.length || 0 }
                },
                'Unterminated double-quoted string',
                DiagnosticSeverity.Warning,
                103,
                'VixChecker'
            )
        );
    }

    if (maskState.inSingleQuote && singleQuoteStart) {
        diagnostics.push(
            Diagnostic.create(
                {
                    start: singleQuoteStart,
                    end: { line: lines.length - 1, character: lines[lines.length - 1]?.length || 0 }
                },
                'Unterminated single-quoted string',
                DiagnosticSeverity.Warning,
                102,
                'VixChecker'
            )
        );
    }

    // 发送诊断信息到客户端
    connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

// 提供代码补全建议
connection.onCompletion(async (textDocumentPosition: TextDocumentPositionParams) => {
    // 获取当前文档
    const document = documents.get(textDocumentPosition.textDocument.uri);
    if (!document) {
        return [];
    }

    const completions: CompletionItem[] = [];

    // 基础关键词补全
    const keywords = [
        { label: 'fn', detail: 'Define a function', insertText: 'function ${1:name}(${2:params}) {\n\t${0}\n}' },
        { label: 'if', detail: 'If statement', insertText: 'if (${1:condition}) {\n\t${0}\n}' },
        { label: 'ifelse', detail: 'If-Else statement', insertText: 'if (${1:condition}) {\n\t${2}\n} else {\n\t${0}\n}' },
        { label: 'for', detail: 'For loop', insertText: 'for (let ${1:i} = 0; ${1:i} < ${2:length}; ${1:i}++) {\n\t${0}\n}' },
        { label: 'while', detail: 'While loop', insertText: 'while (${1:condition}) {\n\t${0}\n}' },
        { label: 'variable', detail: 'Variable declaration', insertText: 'let ${1:name} = ${0};' },
        { label: 'const', detail: 'Constant declaration', insertText: 'const ${1:name} = ${0};' },
        { label: 'console.log', detail: 'Log to console', insertText: 'console.log(${0});' },
        { label: 'class', detail: 'Class declaration', insertText: 'class ${1:Name} {\n\tconstructor(${2:args}) {\n\t\t${0}\n\t}\n}' },
        { label: 'import', detail: 'Import statement', insertText: 'import { ${1} } from \'${0}\';' },
        { label: 'return', detail: 'Return statement', insertText: 'return ${0};' }
    ];

    keywords.forEach(keyword => {
        completions.push({
            label: keyword.label,
            kind: CompletionItemKind.Keyword,
            detail: keyword.detail,
            insertText: keyword.insertText,
            insertTextFormat: 2 // Snippet format
        });
    });

    // 特定 Vix 语言函数补全
    const vixFunctions = [
        { label: 'print', detail: 'Print to output', insertText: 'print(${0:text});' },
        { label: 'read', detail: 'Read input', insertText: 'read(${0:prompt});' },
        { label: 'wait', detail: 'Wait for delay', insertText: 'wait(${0:milliseconds});' },
        { label: 'parse', detail: 'Parse expression', insertText: 'parse(${0:expr});' },
        { label: 'toint', detail: 'Convert to integer', insertText: 'toint(${0:value});' },
        { label:  'tofloat', detail: 'Convert to float', insertText: 'tofloat(${0:value});' },
        { label: 'tostring', detail: 'Convert to string', insertText: 'tostring(${0:value});' },
        { label: 'length', detail: 'Get length of collection', insertText: 'length(${0:collection});' },
        { label: 'add', detail: 'Append to collection', insertText: 'add(${0:collection}, ${1:item});' },
        { label: 'remove', detail: 'Remove from collection', insertText: 'remove(${0:collection}, ${1:index});' }

    ];

    vixFunctions.forEach(func => {
        completions.push({
            label: func.label,
            kind: CompletionItemKind.Method,
            detail: func.detail,
            insertText: func.insertText,
            insertTextFormat: 2
        });
    });

    return completions;
});

// 解析补全项
connection.onCompletionResolve((item: CompletionItem) => {
    if (item.data === 1) {
        item.detail = 'Vix details';
        item.documentation = 'Vix documentation';
    }
    return item;
});

// 监听文档改变
documents.listen(connection);

// 监听连接
connection.listen();