'use strict';
const vscode = require('vscode');
const path = require('path');
const { EpubReaderProvider, VIEW_TYPE, isReaderSetting } = require('./readerProvider');

function activate(context) {
  const provider = new EpubReaderProvider(context);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false
    })
  );

  // 设置在 VS Code 设置界面被改动时，实时同步到所有已打开的阅读器
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (isReaderSetting(e)) provider.refreshSettings();
    })
  );

  const openWithReader = async (uri, options) => {
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, options || { preview: false });
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeEpub.openFile', async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: true,
        filters: { 'EPUB 电子书': ['epub'] },
        openLabel: '用阅读器打开'
      });
      if (!picked || !picked.length) return;
      for (const uri of picked) {
        await openWithReader(uri);
      }
    }),

    vscode.commands.registerCommand('vscodeEpub.recent', async () => {
      const recent = provider.store.recent();
      if (!recent.length) {
        vscode.window.showInformationMessage('还没有阅读记录。');
        return;
      }
      const items = recent.map((item) => ({
        label: item.title || path.basename(item.path),
        description: item.path,
        detail: new Date(item.updatedAt).toLocaleString('zh-CN'),
        uri: vscode.Uri.file(item.path)
      }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: '选择一本最近阅读的书',
        matchOnDescription: true
      });
      if (picked) await openWithReader(picked.uri);
    }),

    vscode.commands.registerCommand('vscodeEpub.prevPage', () => {
      if (!provider.sendCommand('prevPage')) vscode.window.setStatusBarMessage('请先打开一本 EPUB', 2000);
    }),

    vscode.commands.registerCommand('vscodeEpub.nextPage', () => {
      if (!provider.sendCommand('nextPage')) vscode.window.setStatusBarMessage('请先打开一本 EPUB', 2000);
    }),

    vscode.commands.registerCommand('vscodeEpub.toggleToc', () => {
      if (!provider.sendCommand('toggleToc')) vscode.window.setStatusBarMessage('请先打开一本 EPUB', 2000);
    }),

    vscode.commands.registerCommand('vscodeEpub.openSettings', () => {
      // 复用 VS Code 原生设置界面，所有排版项都在这里改，不另做一套设置面板
      vscode.commands.executeCommand('workbench.action.openSettings', 'vscodeEpub');
    }),

    vscode.commands.registerCommand('vscodeEpub.clearProgress', () => {
      if (!provider.sendCommand('clearProgress')) vscode.window.setStatusBarMessage('请先打开一本 EPUB', 2000);
    })
  );
}

function deactivate() { }

module.exports = { activate, deactivate };
