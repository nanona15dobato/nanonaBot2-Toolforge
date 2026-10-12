const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { loadRegistry, validateRegistry, toJobsYaml, toWikiJson } = require('./task-registry');

const projectRoot = path.join(__dirname, '..');
const srcDir = path.join(projectRoot, 'src');
const distDir = path.join(projectRoot, 'dist');

if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
}

const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const overallVersion = pkg.version;

const versionList = {};
const declaredTaskIds = {};
const duplicateTaskIdErrors = [];

function collectJsFiles(dir, results = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            collectJsFiles(fullPath, results);
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
            results.push(fullPath);
        }
    }
    return results;
}

const files = collectJsFiles(srcDir);

function getFileLastModified(absolutePath) {
    try {
        const projectRoot = path.join(__dirname, '..');
        const relativePath = path.relative(projectRoot, absolutePath);
        
        const cmd = `git log -1 --format=%cI -- "${relativePath}"`;
        const dateStr = execSync(cmd, { cwd: projectRoot }).toString().trim();
        
        if (dateStr) return dateStr;
    } catch (err) {
        console.warn(`Git log warning for ${absolutePath}`);
    }
    return new Date().toISOString();
}

files.forEach(srcPath => {
    const relPath = path.relative(srcDir, srcPath);
    const distPath = path.join(distDir, relPath);
    const distSubDir = path.dirname(distPath);

    if (!fs.existsSync(distSubDir)) {
        fs.mkdirSync(distSubDir, { recursive: true });
    }
    
    let content = fs.readFileSync(srcPath, 'utf8');
    
    const hash = crypto.createHash('md5').update(content).digest('hex').slice(0, 8);
    
    content = content.replace(/__FILE_HASH__/g, hash);
    fs.writeFileSync(distPath, content);
    
    // taskIdの抽出と履歴の記録
    const idMatch = content.match(/const\s+taskId\s*=\s*['"]([^'"]+)['"]/);
    if (idMatch) {
        const taskId = idMatch[1];
        if (declaredTaskIds[taskId]) {
            duplicateTaskIdErrors.push(`${taskId}: src/${declaredTaskIds[taskId]} と src/${relPath} で重複して宣言されています`);
        }
        declaredTaskIds[taskId] = relPath;
        const lastUpdated = getFileLastModified(srcPath);

        versionList[taskId] = {
            file: relPath,
            hash: hash,
            last_updated: lastUpdated
        };
    }
});

// タスク台帳の検証
const registry = loadRegistry();
const registryErrors = [
    ...duplicateTaskIdErrors,
    ...validateRegistry(registry, { srcDir, declaredTaskIds })
];
if (registryErrors.length) {
    console.error('tasks.json に問題があります:');
    registryErrors.forEach(e => console.error(`- ${e}`));
    process.exit(1);
}

fs.copyFileSync(path.join(projectRoot, 'package.json'), path.join(distDir, 'package.json'));
fs.copyFileSync(path.join(projectRoot, 'package-lock.json'), path.join(distDir, 'package-lock.json'));
fs.copyFileSync(path.join(projectRoot, 'tasks.json'), path.join(distDir, 'tasks.json'));
fs.writeFileSync(path.join(distDir, 'myjobs.yaml'), toJobsYaml(registry));

const buildDate = new Date().toISOString();

// Wiki更新用のJSONを生成
const wikiJsonData = {
    overall_version: overallVersion,
    build_date: buildDate,
    files: versionList,
    wiki: toWikiJson(registry, { overallVersion, buildDate, files: versionList })
};


fs.writeFileSync(path.join(projectRoot, 'version_info.json'), JSON.stringify(wikiJsonData, null, 2));
fs.writeFileSync(path.join(distDir, 'version_info.json'), JSON.stringify(wikiJsonData, null, 2));
fs.copyFileSync(
    path.join(projectRoot, 'scripts', 'update-wiki.js'),
    path.join(distDir, 'update-wiki.js')
);
fs.copyFileSync(
    path.join(projectRoot, 'scripts', 'archive-logs.js'),
    path.join(distDir, 'archive-logs.js')
);

console.log('Build complete. version_info.json, tasks.json, myjobs.yaml generated.');
