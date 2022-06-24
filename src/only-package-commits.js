const { identity, memoizeWith, pipeP } = require('ramda');
const pkgUp = require('pkg-up');
const readPkg = require('read-pkg');
const path = require('path');
const pLimit = require('p-limit');
const debug = require('debug')('semantic-release:monorepo');
const { getCommitFiles, getRoot } = require('./git-utils');
const { mapCommits } = require('./options-transforms');
const fs = require('fs');

const memoizedGetCommitFiles = memoizeWith(identity, getCommitFiles);

/**
 * Get the normalized PACKAGE root path, relative to the git PROJECT root.
 */
const getPackagePath = async () => {
  const packagePath = await pkgUp();
  const gitRoot = await getRoot();

  return path.relative(gitRoot, path.resolve(packagePath, '..'));
};

const withFiles = async commits => {
  const limit = pLimit(Number(process.env.SRM_MAX_THREADS) || 500);
  return Promise.all(
    commits.map(commit =>
      limit(async () => {
        const files = await memoizedGetCommitFiles(commit.hash);
        return { ...commit, files };
      })
    )
  );
};

const onlyPackageCommits = async (analyzeLinkedDependencies, commits) => {
  let packagesIncluded = [];

  if (analyzeLinkedDependencies) {
    const gitRoot = await getRoot();
    const packagesDir = fs.readdirSync(path.resolve(gitRoot, analyzeLinkedDependencies.dir));
  
    const packageJson = JSON.parse(fs.readFileSync(path.resolve(gitRoot, await getPackagePath(), 'package.json'), 'utf8'));

    packagesIncluded = Object.keys(packageJson.dependencies)
      .filter(dependency => packagesDir.includes(dependency))
      .map(package => path.join(analyzeLinkedDependencies.dir, package));
  }
  
  const packagePaths = [await getPackagePath(), ...packagesIncluded];
  console.log('packagePath: ', packagePaths);

  debug('Filter commits by package path: "%s"', packagePaths);
  const commitsWithFiles = await withFiles(commits);
  // Convert package root path into segments - one for each folder

  const commitsArray = packagePaths.map(packagePath => {
    const packageSegments = packagePath.split(path.sep);

    return commitsWithFiles.filter(({ files, subject }) => {
      // Normalise paths and check if any changed files' path segments start
      // with that of the package root.
      const packageFile = files.find(file => {
        const fileSegments = path.normalize(file).split(path.sep);
        // Check the file is a *direct* descendent of the package folder (or the folder itself)
        return packageSegments.every(
          (packageSegment, i) => packageSegment === fileSegments[i]
        );
      });
  
      if (packageFile) {
        debug(
          'Including commit "%s" because it modified package file "%s".',
          subject,
          packageFile
        );
      }
  
      return !!packageFile;
    });
  })

  return commitsArray.flat();
};

// Async version of Ramda's `tap`
const tapA = fn => async x => {
  await fn(x);
  return x;
};

const logFilteredCommitCount = logger => async ({ commits }) => {
  const { name } = await readPkg();

  logger.log(
    'Found %s commits for package %s since last release',
    commits.length,
    name
  );
};

const withOnlyPackageCommits = (plugin) => async (pluginConfig, config) => {
  console.log('pluginConfig: ', pluginConfig);
  const { logger } = config;

  return plugin(
    pluginConfig,
    await pipeP(
      mapCommits((commits) => onlyPackageCommits(pluginConfig.analyzeLinkedDependencies, commits)),
      tapA(logFilteredCommitCount(logger))
    )(config)
  );
};

module.exports = withOnlyPackageCommits;
