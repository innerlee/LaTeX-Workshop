import * as vscode from 'vscode'
import * as fs from 'fs'

import {Extension} from '../../main'

export class Command {
    extension: Extension
    selection: string = ''
    shouldClearSelection: boolean = true
    suggestions: vscode.CompletionItem[]
    commandInTeX: { [id: string]: {[id: string]: AutocompleteEntry} } = {}
    refreshTimer: number
    defaultCommands: {[key: string]: vscode.CompletionItem} = {}
    newcommandData: {[id: string]: {position: vscode.Position, file: string}} = {}
    specialBrackets: {[key: string]: vscode.CompletionItem}

    constructor(extension: Extension) {
        this.extension = extension
    }

    initialize(defaultCommands: {[key: string]: AutocompleteEntry},
               defaultSymbols: {[key: string]: AutocompleteEntry},
               defaultEnvs: {[key: string]: {text: string}}) {
        Object.keys(defaultCommands).forEach(key => {
            if (!(key in defaultSymbols)) {
                defaultSymbols[key] = defaultCommands[key]
            }
        })
        const envSnippet: { [id: string]: { command: string, snippet: string}} = {}
        Object.keys(defaultEnvs).forEach(env => {
            const text = defaultEnvs[env].text
            envSnippet[env] = {
                command: text,
                snippet: `begin{${text}}\n\t$0\n\\\\end{${text}}`
            }
            if (['enumerate', 'itemize'].indexOf(text) > -1) {
                envSnippet[env]['snippet'] = `begin{${text}}\n\t\\item $0\n\\\\end{${text}}`
            }
        })
        Object.keys(defaultSymbols).forEach(key => {
            const item = defaultSymbols[key]
            this.defaultCommands[key] = this.entryToCompletionItem(item)
        })
        Object.keys(envSnippet).forEach(key => {
            const item = envSnippet[key]
            const command = new vscode.CompletionItem(`\\begin{${item.command}} ... \\end{${item.command}}`, vscode.CompletionItemKind.Snippet)
            command.filterText = item.command
            command.insertText = new vscode.SnippetString(item.snippet)
            this.defaultCommands[key] = command
        })
        const bracketCommands = {'latexinlinemath': '(', 'latexdisplaymath': '[', 'curlybrackets': '{', 'lrparen': 'left(', 'lrbrack': 'left[', 'lrcurly': 'left\\{'}
        this.specialBrackets = Object.keys(this.defaultCommands)
            .filter(key => bracketCommands.hasOwnProperty(key))
            .reduce((obj, key) => {
                obj[bracketCommands[key]] = this.defaultCommands[key]
                return obj
            }, {})
    }

    provide() : vscode.CompletionItem[] {
        if (Date.now() - this.refreshTimer < 1000) {
            return this.suggestions
        }
        this.refreshTimer = Date.now()
        const suggestions = Object.assign({}, this.defaultCommands)
        Object.keys(this.extension.manager.texFileTree).forEach(filePath => {
            if (filePath in this.commandInTeX) {
                Object.keys(this.commandInTeX[filePath]).forEach(key => {
                    if (!(key in suggestions)) {
                        suggestions[key] = this.entryToCompletionItem(this.commandInTeX[filePath][key])
                    }
                })
            }
        })
        if (vscode.window.activeTextEditor) {
            const items = this.getCommandItems(vscode.window.activeTextEditor.document.getText(), vscode.window.activeTextEditor.document.fileName)
            Object.keys(items).forEach(key => {
                if (!(key in suggestions)) {
                    suggestions[key] = this.entryToCompletionItem(items[key])
                }
            })
        }
        this.suggestions = Object.keys(suggestions).map(key => suggestions[key])
        return this.suggestions
    }

    surround(content: string) {
        if (!vscode.window.activeTextEditor) {
            return
        }
        const editor = vscode.window.activeTextEditor
        const candidate: string[] = []
        this.provide().forEach(item => {
            if (item.insertText === undefined) {
                return
            }
            if (item.label === '\\begin') { // Causing a lot of trouble
                return
            }
            const command = (typeof item.insertText !== 'string') ? item.insertText.value : item.insertText
            if (command.match(/(.*)(\${\d.*?})/)) {
                candidate.push(command.replace(/\n/g, '').replace(/\t/g, '').replace('\\\\', '\\'))
            }
        })
        vscode.window.showQuickPick(candidate, {
            placeHolder: 'Press ENTER to surround previous selection with selected command',
            matchOnDetail: true,
            matchOnDescription: true
        }).then(selected => {
            if (selected === undefined) {
                return
            }
            editor.edit(edit => edit.replace(new vscode.Range(editor.selection.start, editor.selection.end),
                                             selected.replace(/(.*)(\${\d.*?})/, `$1${content}`) // Replace text
                                                     .replace(/\${\d:?(.*?)}/g, '$1') // Remove snippet placeholders
                                                     .replace('\\\\', '\\') // Unescape backslashes, e.g., begin{${1:env}}\n\t$2\n\\\\end{${1:env}}
                                                     .replace(/\$\d/, ''))) // Remove $2 etc
        })
        return
    }

    entryToCompletionItem(item: AutocompleteEntry) : vscode.CompletionItem {
        const backslash = item.command[0] === ' ' ? '' : '\\'
        const command = new vscode.CompletionItem(`${backslash}${item.command}`, vscode.CompletionItemKind.Function)
        if (item.snippet) {
            command.insertText = new vscode.SnippetString(item.snippet)
        } else {
            command.insertText = item.command
        }
        command.documentation = item.documentation
        command.detail = item.detail
        command.sortText = item.sortText
        command.preselect = item.preselect
        if (item.postAction) {
            command.command = { title: 'Post-Action', command: item.postAction }
        }
        return command
    }

    getCommandsTeX(filePath: string) {
        this.commandInTeX[filePath] = this.getCommandItems(fs.readFileSync(filePath, 'utf-8'), filePath)
    }

    getCommandItems(content: string, filePath: string) : { [id: string]: AutocompleteEntry } {
        const itemReg = /\\([a-zA-Z]+)({[^{}]*})?({[^{}]*})?({[^{}]*})?/g
        const items = {}
        while (true) {
            const result = itemReg.exec(content)
            if (result === null) {
                break
            }
            items[result[1]] = {
                command: result[1]
            }
            if (result[2]) {
                items[result[1]].snippet = `${result[1]}{$\{1}}`
                // Automatically trigger intellisense if the command matches citation, reference or ennvironment completion
                if (result[1].match(/([a-zA-Z]*(cite|ref)[a-zA-Z]*)|(begin)/)) {
                    items[result[1]].postAction = 'editor.action.triggerSuggest'
                }
            }
            if (result[3]) {
                items[result[1]].snippet += `{$\{2}}`
            }
            if (result[4]) {
                items[result[1]].snippet += `{$\{3}}`
            }
        }

        const newCommandReg = /\\(?:re|provide)?(?:new)?command(?:{)?\\(\w+)/g
        while (true) {
            const result = newCommandReg.exec(content)
            if (result === null) {
                break
            }
            if (result[1] in this.newcommandData) {
                continue
            }
            this.newcommandData[result[1]] = {
                position: new vscode.Position(content.substr(0, result.index).split('\n').length - 1, 0),
                file: filePath
            }
        }

        return items
    }
}

interface AutocompleteEntry {
    command: string
    snippet?: string
    detail?: string
    description?: string
    documentation?: string
    sortText?: string
    postAction?: string
    preselect?: boolean
}
