var fs = require('fs');
var fse = require('fs-extra');
var path = require('path');
var ts = require('typescript');
var diffing_broccoli_plugin_1 = require('./diffing-broccoli-plugin');
var FS_OPTS = { encoding: 'utf-8' };
/**
 * Broccoli plugin that implements incremental Typescript compiler.
 *
 * It instantiates a typescript compiler instance that keeps all the state about the project and
 * can reemit only the files that actually changed.
 *
 * Limitations: only files that map directly to the changed source file via naming conventions are
 * reemited. This primarily affects code that uses `const enum`s, because changing the enum value
 * requires global emit, which can affect many files.
 */
var DiffingTSCompiler = (function () {
    function DiffingTSCompiler(inputPath, cachePath, options) {
        this.inputPath = inputPath;
        this.cachePath = cachePath;
        this.options = options;
        this.fileRegistry = Object.create(null);
        this.firstRun = true;
        this.previousRunFailed = false;
        this.tsOpts = Object.create(options);
        this.tsOpts.outDir = this.cachePath;
        this.tsOpts.target = ts.ScriptTarget[options.target];
        this.rootFilePaths = options.rootFilePaths ? options.rootFilePaths.splice(0) : [];
        this.tsServiceHost = new CustomLanguageServiceHost(this.tsOpts, this.rootFilePaths, this.fileRegistry, this.inputPath);
        this.tsService = ts.createLanguageService(this.tsServiceHost, ts.createDocumentRegistry());
    }
    DiffingTSCompiler.prototype.rebuild = function (treeDiff) {
        var _this = this;
        var pathsToEmit = [];
        var pathsWithErrors = [];
        treeDiff.changedPaths
            .forEach(function (tsFilePath) {
                if (!_this.fileRegistry[tsFilePath]) {
                    _this.fileRegistry[tsFilePath] = { version: 0 };
                    _this.rootFilePaths.push(tsFilePath);
                }
                else {
                    _this.fileRegistry[tsFilePath].version++;
                }
                pathsToEmit.push(tsFilePath);
            });
        treeDiff.removedPaths
            .forEach(function (tsFilePath) {
                console.log('removing outputs for', tsFilePath);
                _this.rootFilePaths.splice(_this.rootFilePaths.indexOf(tsFilePath), 1);
                _this.fileRegistry[tsFilePath] = null;
                _this.removeOutputFor(tsFilePath);
            });
        if (this.firstRun) {
            this.firstRun = false;
            this.doFullBuild();
        }
        else {
            pathsToEmit.forEach(function (tsFilePath) {
                var output = _this.tsService.getEmitOutput(tsFilePath);
                if (output.emitSkipped) {
                    var errorFound = _this.logError(tsFilePath);
                    if (errorFound) {
                        pathsWithErrors.push(tsFilePath);
                    }
                }
                else {
                    output.outputFiles.forEach(function (o) {
                        var destDirPath = path.dirname(o.name);
                        fse.mkdirsSync(destDirPath);
                        fs.writeFileSync(o.name, o.text, FS_OPTS);
                    });
                }
            });
            if (pathsWithErrors.length) {
                this.previousRunFailed = true;
                throw new Error('Typescript found errors listed above...');
            }
            else if (this.previousRunFailed) {
                this.doFullBuild();
            }
        }
    };
    DiffingTSCompiler.prototype.logError = function (tsFilePath) {
        var allDiagnostics = this.tsService.getCompilerOptionsDiagnostics()
            .concat(this.tsService.getSyntacticDiagnostics(tsFilePath))
            .concat(this.tsService.getSemanticDiagnostics(tsFilePath));
        allDiagnostics.forEach(function (diagnostic) {
            var message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
            if (diagnostic.file) {
                var _a = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start), line = _a.line, character = _a.character;
                console.log(("  Error " + diagnostic.file.fileName + " (" + (line + 1) + "," + (character + 1) + "): ") +
                ("" + message));
            }
            else {
                console.log("  Error: " + message);
            }
        });
        return !!allDiagnostics.length;
    };
    DiffingTSCompiler.prototype.doFullBuild = function () {
        var program = this.tsService.getProgram();
        var emitResult = program.emit(undefined, function (absoluteFilePath, fileContent) {
            fse.mkdirsSync(path.dirname(absoluteFilePath));
            fs.writeFileSync(absoluteFilePath, fileContent, FS_OPTS);
        });
        if (emitResult.emitSkipped) {
            var allDiagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics);
            var errorMessages = [];
            allDiagnostics.forEach(function (diagnostic) {
                var _a = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start), line = _a.line, character = _a.character;
                var message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
                errorMessages.push("  " + diagnostic.file.fileName + " (" + (line + 1) + "," + (character + 1) + "): " + message);
            });
            if (errorMessages.length) {
                this.previousRunFailed = true;
                console.log(errorMessages.join('\n'));
                throw new Error('Typescript found errors listed above...');
            }
            else {
                this.previousRunFailed = false;
            }
        }
    };
    DiffingTSCompiler.prototype.removeOutputFor = function (tsFilePath) {
        var absoluteJsFilePath = path.join(this.cachePath, tsFilePath.replace(/\.ts$/, '.js'));
        var absoluteMapFilePath = path.join(this.cachePath, tsFilePath.replace(/.ts$/, '.js.map'));
        var absoluteDtsFilePath = path.join(this.cachePath, tsFilePath.replace(/\.ts$/, '.d.ts'));
        if (fs.existsSync(absoluteJsFilePath)) {
            fs.unlinkSync(absoluteJsFilePath);
            fs.unlinkSync(absoluteMapFilePath);
            fs.unlinkSync(absoluteDtsFilePath);
        }
    };
    DiffingTSCompiler.includeExtensions = ['.ts'];
    DiffingTSCompiler.excludeExtensions = ['.d.ts'];
    return DiffingTSCompiler;
})();
var CustomLanguageServiceHost = (function () {
    function CustomLanguageServiceHost(compilerOptions, fileNames, fileRegistry, treeInputPath) {
        this.compilerOptions = compilerOptions;
        this.fileNames = fileNames;
        this.fileRegistry = fileRegistry;
        this.treeInputPath = treeInputPath;
        this.currentDirectory = process.cwd();
        this.defaultLibFilePath = ts.getDefaultLibFilePath(compilerOptions).replace(/\\/g, '/');
    }
    CustomLanguageServiceHost.prototype.getScriptFileNames = function () { return this.fileNames; };
    CustomLanguageServiceHost.prototype.getScriptVersion = function (fileName) {
        return this.fileRegistry[fileName] && this.fileRegistry[fileName].version.toString();
    };
    /**
     * This method is called quite a bit to lookup 3 kinds of paths:
     * 1/ files in the fileRegistry
     *   - these are the files in our project that we are watching for changes
     *   - in the future we could add caching for these files and invalidate the cache when
     *     the file is changed lazily during lookup
     * 2/ .d.ts and library files not in the fileRegistry
     *   - these are not our files, they come from tsd or typescript itself
     *   - these files change only rarely but since we need them very rarely, it's not worth the
     *     cache invalidation hassle to cache them
     * 3/ bogus paths that typescript compiler tries to lookup during import resolution
     *   - these paths are tricky to cache since files come and go and paths that was bogus in the
     *     past might not be bogus later
     *
     * In the initial experiments the impact of this caching was insignificant (single digit %) and
     * not worth the potential issues with stale cache records.
     */
    CustomLanguageServiceHost.prototype.getScriptSnapshot = function (tsFilePath) {
        var absoluteTsFilePath = (tsFilePath == this.defaultLibFilePath) ?
            tsFilePath :
            path.join(this.treeInputPath, tsFilePath);
        if (!fs.existsSync(absoluteTsFilePath)) {
            // TypeScript seems to request lots of bogus paths during import path lookup and resolution,
            // so we we just return undefined when the path is not correct.
            return undefined;
        }
        return ts.ScriptSnapshot.fromString(fs.readFileSync(absoluteTsFilePath, FS_OPTS));
    };
    CustomLanguageServiceHost.prototype.getCurrentDirectory = function () { return this.currentDirectory; };
    CustomLanguageServiceHost.prototype.getCompilationSettings = function () { return this.compilerOptions; };
    CustomLanguageServiceHost.prototype.getDefaultLibFileName = function (options) {
        // ignore options argument, options should not change during the lifetime of the plugin
        return this.defaultLibFilePath;
    };
    return CustomLanguageServiceHost;
})();
exports["default"] = diffing_broccoli_plugin_1.wrapDiffingPlugin(DiffingTSCompiler);
