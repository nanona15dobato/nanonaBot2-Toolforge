const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const srcDir = path.join(__dirname, '..', 'src');
const distDir = path.join(__dirname, '..', 'dist');

if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
}

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const overallVersion = pkg.version;

const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.js'));
const versionList = {};

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

files.forEach(file => {
    const srcPath = path.join(srcDir, file);
    const distPath = path.join(distDir, file);
    
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
            file: file,
            hash: hash,
            last_updated: lastUpdated
        };
    }
});

fs.copyFileSync(
    path.join(__dirname, '..', 'package.json'),
    path.join(distDir, 'package.json')
);

// Wiki更新用のJSONを生成
const wikiJsonData = {
    overall_version: overallVersion,
    build_date: new Date().toISOString(),
    files: versionList
};

fs.writeFileSync(
    path.join(__dirname, '..', 'version_info.json'),
    JSON.stringify(wikiJsonData, null, 2)
);

console.log('Build complete. version_info.json generated.');