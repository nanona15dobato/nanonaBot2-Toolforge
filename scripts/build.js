const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const projectRoot = path.join(__dirname, '..');
const srcDir = path.join(projectRoot, 'src');
const distDir = path.join(projectRoot, 'dist');

if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
}

const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const overallVersion = pkg.version;

const versionList = {};

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
        const lastUpdated = getFileLastModified(srcPath);

        versionList[taskId] = {
            file: relPath,
            hash: hash,
            last_updated: lastUpdated
        };
    }
});

fs.copyFileSync(path.join(projectRoot, 'package.json'), path.join(distDir, 'package.json'));
fs.copyFileSync(path.join(projectRoot, 'package-lock.json'), path.join(distDir, 'package-lock.json'));

// Wiki更新用のJSONを生成
const wikiJsonData = {
    overall_version: overallVersion,
    build_date: new Date().toISOString(),
    files: versionList
};


fs.writeFileSync(path.join(projectRoot, 'version_info.json'), JSON.stringify(wikiJsonData, null, 2));
fs.writeFileSync(path.join(distDir, 'version_info.json'), JSON.stringify(wikiJsonData, null, 2));
fs.copyFileSync(
    path.join(projectRoot, 'scripts', 'update-wiki.js'),
    path.join(distDir, 'update-wiki.js')
);

console.log('Build complete. version_info.json generated.');