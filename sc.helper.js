const fs = require("fs");
const fsExtra = require("fs-extra");
const path = require("path");
const chalk = require("chalk");
const spawn = require("child_process").spawn;
const extract = require("extract-zip");
const deleteEmpty = require("delete-empty");
const klaw = require("klaw-sync");
const isValidPath = require("is-valid-path");
const config = require("./config");

let cfg = {
  resPathPart: "960x640",
  langPathPart: "en_US",
  fileVersionSuffix: "-0001",
  ATFAtlasNameToExclude: "fonts",
  tempDir: "tmp",
  GAFTempResultDir: "tmp_result_gaf",
  pvrFilesSuffix: "_low",
  workSubDir: "slots",
  manifestFileName: "manifest.json",
  assetsFilesExtensions: [".atf", ".atf_low", ".zip", ".zip_low"]
};

function run() {
  parseArgs();
  Object.assign(cfg, config);
  runTasks(getTasks());
}

function parseArgs() {
  let platforms = ["web", "ios", "android"];
  let tasks = ["all", "atf", "gaf"];

  process.argv.forEach(val => {
    let splitParam = val.split("=");
    if (splitParam.length > 1) {
      if (splitParam[0] == "p" && platforms.includes(splitParam[1])) {
        config.platform = splitParam[1];
      }

      if (splitParam[0] == "c" && tasks.includes(splitParam[1])) {
        config.command = splitParam[1];
      }

      if (splitParam[0] == "t") {
        config.target = splitParam[1];
      }

      if (splitParam[0] == "um") {
        config.updateIOSManifest = splitParam[1];
      }

      if (splitParam[0] == "rs") {
        config.removeSources = splitParam[1];
      }
    }
  });
}

function getTasks() {
  let atfRGBAFn = () => compressAllAtlases("rgba");
  let atfPVRFn = () => compressAllAtlases("pvr");
  let atfETCFn = () => compressAllAtlases("etc");
  let gafFn = () => prepareGAFZips(cfg.platform);

  let handlers = {
    web: {
      atf: [atfRGBAFn],
      gaf: [gafFn],
      all: [atfRGBAFn, gafFn]
    },
    ios: {
      atf: [atfRGBAFn, atfPVRFn],
      gaf: [gafFn],
      all: [atfRGBAFn, atfPVRFn, gafFn]
    },
    android: {
      atf: [atfETCFn],
      gaf: [gafFn],
      all: [atfETCFn, gafFn]
    }
  };

  let tasks = addSpecialTasks(handlers[cfg.platform][cfg.command]);
  tasks = [start].concat(tasks, finish);
  return tasks;
}

function addSpecialTasks(tasks) {
  if (cfg.platform == "ios" && cfg.updateIOSManifest) {
    tasks.push(updateIOSResourcesManifest);
  }

  if (
    (cfg.platform == "ios" || cfg.platform == "android") &&
    cfg.removeSources
  ) {
    tasks.push(removeSources);
  }

  return tasks;
}

function runTasks(list) {
  return list.reduce((result, fn) => result.then(fn), Promise.resolve());
}

function compressAllAtlases(compressionType) {
  return new Promise(resolve => {
    console.log(`Preparing ${compressionType.toUpperCase()} atlases...`);
    let manifest = JSON.parse(fs.readFileSync(resolveManifestPath(), "utf8"));
    let atlases = [];

    manifest.forEach(item => {
      if (
        item.e &&
        item.n &&
        ~item.e.indexOf("atf") &&
        (compressionType == "rgba" ||
          !item.n.includes(cfg.ATFAtlasNameToExclude))
      ) {
        let fileName = item.n + cfg.fileVersionSuffix + ".png";
        if (cfg.target == "all" || item.n == cfg.target) {
          atlases.push(resolveFilePath(item.n, fileName));
        }
      }
    });

    let promises = [];

    atlases.forEach(item => {
      let promise = compressAtlas(item, compressionType, false);
      promises.push(promise);
    });

    Promise.all(promises).then(resolve);
  });
}

function compressAtlas(sourcePath, compressionType, isArchive) {
  return new Promise(resolve => {
    if (!compressionType) compressionType = "rgba";
    let info = path.parse(sourcePath);
    let suffix =
      isArchive || compressionType == "rgba" || compressionType == "etc" ?
      "" :
      cfg.pvrFilesSuffix;
    let resultPath = path.join(info.dir, info.name + ".atf" + suffix);
    let ls = runATFTool(sourcePath, resultPath, compressionType);
    addSTDHandlers(resolve, ls);
  });
}

function runATFTool(sourcePath, resultPath, compressionType) {
  let paramsByCompressionType = {
    rgba: [
      ".",
      "-e",
      "-q",
      cfg.ATFQuantification,
      "-i",
      sourcePath,
      "-o",
      resultPath
    ],
    pvr: [".", "-c", "p", "-r", "-e", "-i", sourcePath, "-o", resultPath],
    etc: [".", "-c", "e", "-r", "-e", "-i", sourcePath, "-o", resultPath]
  };

  return spawn(
    cfg.ATFToolsPath + "png2atf",
    paramsByCompressionType[compressionType]
  );
}

function addSTDHandlers(resolve, ls) {
  ls.stdout.on("data", data => {});

  ls.stderr.on("data", data => {
    logError(data);
  });

  ls.on("exit", code => {
    resolve();
  });
}

function prepareGAFZips(platform) {
  return new Promise(resolve => {
    let archives = getGAFZipsListFromManifest();
    let handlers = {
      web: () => processGAFZips(archives, "rgba"),
      ios: () =>
        processGAFZips(archives, "rgba").then(() =>
          processGAFZips(archives, "pvr")
        ),
      android: () => processGAFZips(archives, "etc")
    };

    copyGAFZipsToTempDir(archives)
      .then(handlers[platform])
      .then(removeZipsTempDirs)
      .then(resolve);
  });
}

function processGAFZips(archives, compressionType) {
  console.log(`Preparing ${compressionType.toUpperCase()} GAF zips...`);
  return new Promise(resolve => {
    packAllGAFZips(compressionType)
      .then(value => copyGAFZipsToSlotDir(value))
      .then(resolve);
  });
}

function getGAFZipsListFromManifest() {
  let manifest = JSON.parse(fs.readFileSync(resolveManifestPath(), "utf8"));
  let archives = [];

  manifest.forEach(item => {
    if (item.e && item.n && ~item.e.indexOf("zip")) {
      let fileName = item.n + cfg.fileVersionSuffix + ".zip";
      archives.push(resolveFilePath(item.n, fileName));
    }
  });

  return archives;
}

function copyGAFZipsToTempDir(archives) {
  return new Promise(resolve => {
    let tmpDirFullPath = path.join(__dirname, cfg.tempDir);
    if (!fs.existsSync(tmpDirFullPath)) fs.mkdirSync(tmpDirFullPath);
    archives.forEach(item => {
      let targetFile = path.join(tmpDirFullPath, path.parse(item).base);
      fsExtra.copySync(item, targetFile);
    });

    resolve();
  });
}

function copyGAFZipsToSlotDir(value) {
  return new Promise((resolve, reject) => {
    let tmpDirPath = path.join(__dirname, cfg.GAFTempResultDir) + "/";
    if (!fs.existsSync(tmpDirPath)) {
      resolve();
    } else {
      readDir(tmpDirPath, (sourcePath, internalResolve) => {
        let info = path.parse(sourcePath);
        if (info.ext == ".zip") {
          let dirNameWithVersionSuffix = sourcePath.split("/").pop();
          let dirName = dirNameWithVersionSuffix.substr(
            0,
            dirNameWithVersionSuffix.lastIndexOf(cfg.fileVersionSuffix)
          );
          let suffix = value.compressionType == "pvr" ? cfg.pvrFilesSuffix : "";
          let fileName = dirNameWithVersionSuffix + suffix;
          let destinationPath = resolveFilePath(dirName, fileName);
          fsExtra.copySync(sourcePath, destinationPath);
        }
        internalResolve();
      }).then(resolve);
    }
  });
}

function removeZipsTempDirs() {
  return new Promise((resolve, reject) => {
    fsExtra.removeSync(path.join(__dirname, cfg.tempDir));
    fsExtra.removeSync(path.join(__dirname, cfg.GAFTempResultDir));
    resolve();
  });
}

function packAllGAFZips(compressionType) {
  return new Promise((resolve, reject) => {
    let tmpDirFullPath = path.join(__dirname, cfg.tempDir) + "/";
    readDir(tmpDirFullPath, (path, internalResolve) =>
      packGAFZip(path, internalResolve, compressionType)
    ).then(() =>
      resolve({
        compressionType: compressionType
      })
    );
  });
}

function packGAFZip(archivePath, repackResolve, compressionType) {
  let zipArchiveName = archivePath.split("/").pop();
  let zipTarget = path
    .parse(zipArchiveName)
    .name.replace(cfg.fileVersionSuffix, "");

  if (
    zipArchiveName.split(".").pop() != "zip" ||
    (cfg.target != "all" && cfg.target != zipTarget)
  ) {
    repackResolve();
    return;
  }

  let zipInstance = new require("node-zip")();
  let tmpDirFullPath = path.join(__dirname, cfg.GAFTempResultDir) + "/";
  let error = false;

  extract(
    archivePath, {
      dir: tmpDirFullPath
    },
    err => {
      if (err) throw err;
      let promises = [];
      let archivePathSplit = archivePath.split("/");
      let archiveName = archivePathSplit.pop();
      archiveName = archiveName.substr(0, archiveName.lastIndexOf("."));
      readDir(tmpDirFullPath + archiveName + "/", (fileName, resolve) => {
        if (fileName.split(".").pop() == "png") {
          let promise = compressAtlas(fileName, compressionType, true).then(
            () => {
              let splitFileName = fileName.split("/");
              let file = splitFileName.pop();
              let atfFilePath = splitFileName.join("/");
              let atfFile = file.substr(0, file.lastIndexOf(".")) + ".atf";
              zipInstance.file(
                archiveName + "/" + atfFile,
                fs.readFileSync(atfFilePath + "/" + atfFile)
              );
              fs.unlink(fileName, () => {});
            }
          );
          promises.push(promise);
          promise.then(resolve);
        } else if (fileName.split(".").pop() == "gaf") {
          let splitFileName = fileName.split("/");
          let file = splitFileName.pop();
          zipInstance.file(archiveName + "/" + file, fs.readFileSync(fileName));
          resolve();
        } else {
          error = true;
          logError(
            `Unexpected file format in GAF zip [${path.parse(fileName).base}]`
          );
          resolve();
        }
      }).then(() =>
        Promise.all(promises).then(() => {
          error = promises.length == 0;
          if (promises.length == 0)
            logError(`No any files in GAF zip [${archiveName}]`);
          if (!error)
            zipGAFArchive(
              zipInstance,
              path.join(tmpDirFullPath, zipArchiveName)
            );
          repackResolve();
        })
      );
    }
  );
}

function zipGAFArchive(zipInstance, archivePath) {
  let data = zipInstance.generate({
    base64: false,
    compression: "DEFLATE",
    compressionOptions: {
      level: 9
    }
  });

  fs.writeFileSync(archivePath, data, "binary");
  let dirPath = archivePath.substr(0, archivePath.lastIndexOf("."));
  fsExtra.removeSync(dirPath);
}

function readDir(path, callback) {
  return new Promise((resolve, reject) => {
    fs.readdir(path, (err, files) => {
      if (err) throw err;
      let promises = [];
      for (let index in files) {
        if (fs.statSync(path + files[index]).isFile()) {
          let promise = new Promise(internalResolve => {
            callback(path + files[index], internalResolve);
          });
          promises.push(promise);
        }
      }
      Promise.all(promises).then(resolve);
    });
  });
}

function removeSources() {
  return new Promise((resolve, reject) => {
    console.log("Removing sources...");
    let slotPath = path.join(cfg.workDir, cfg.workSubDir, cfg.slotName);
    let tmpDirFullPath = path.join(__dirname, cfg.tempDir);
    if (!fs.existsSync(tmpDirFullPath)) fs.mkdirSync(tmpDirFullPath);

    let filterFunc = (src, dest) => {
      let info = path.parse(dest);
      return (
        (fs.statSync(src).isDirectory() ||
          cfg.assetsFilesExtensions.includes(info.ext) ||
          (cfg.platform == "ios" && info.base == cfg.manifestFileName)) &&
        !info.base.includes(cfg.ATFAtlasNameToExclude)
      );
    };

    fsExtra.copySync(slotPath, tmpDirFullPath, {
      filter: filterFunc
    });
    deleteEmpty.sync(tmpDirFullPath);
    fsExtra.removeSync(path.join(slotPath, cfg.resPathPart));
    fsExtra.copySync(tmpDirFullPath, slotPath);
    fsExtra.removeSync(tmpDirFullPath);
    resolve();
  });
}

function updateIOSResourcesManifest() {
  return new Promise(resolve => {
    console.log("Updating manifest...");
    let manifest = JSON.parse(fs.readFileSync(resolveManifestPath(), "utf8"));
    let atfPVR = "atf" + cfg.pvrFilesSuffix;
    let zipPVR = "zip" + cfg.pvrFilesSuffix;
    manifest.forEach(item => {
      if (item.e && item.n && !item.n.includes(cfg.ATFAtlasNameToExclude)) {
        if (~item.e.indexOf("atf") && !~item.e.indexOf(atfPVR)) {
          item.e.push(atfPVR);
        }
        if (~item.e.indexOf("zip") && !~item.e.indexOf(zipPVR)) {
          item.e.push(zipPVR);
        }
      }
    });
    fsExtra.writeJsonSync(resolveManifestPath(), manifest, {
      spaces: 4
    });
    resolve();
  });
}

function inspectFileNamesForSpecialSymbols() {
  let slotPath = path.join(cfg.workDir, cfg.workSubDir, cfg.slotName);
  let files = klaw(slotPath);
  files.forEach(item => {
    if (!isValidPath(item.path)) {
      logError(`Wrong symbols in path: ${item.path}`);
    }
  });
}

function resolveFilePath(dir, fileName) {
  return path.join(
    cfg.workDir,
    cfg.workSubDir,
    cfg.slotName,
    cfg.resPathPart,
    dir,
    cfg.langPathPart,
    fileName
  );
}

function resolveManifestPath() {
  return path.join(
    cfg.workDir,
    cfg.workSubDir,
    cfg.slotName,
    cfg.resPathPart,
    cfg.manifestFileName
  );
}

function logError(msg) {
  console.log(chalk.red(msg));
}

function start() {
  console.time("Processing time");
}

function finish() {
  console.log("Done!");
  console.timeEnd("Processing time");
}

run();