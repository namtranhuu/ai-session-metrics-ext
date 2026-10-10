const vscode = {
    workspace: {
        getConfiguration: () => ({
            get: (key: any, defaultValue?: any) => defaultValue !== undefined ? defaultValue : null
        })
    },
    Uri: {
        file: (f: any) => ({ fsPath: f })
    },
    EventEmitter: class {
        event = () => {};
        fire() {}
    }
};
module.exports = vscode;
