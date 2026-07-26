import fs from 'fs';
import path from 'path';
import protobuf from 'protobufjs';
import Handlebars from 'handlebars';
import chokidar from 'chokidar';

const SRC_DIR = './src';
const TEMPLATE_FILE = './protos/service.hbs';

console.log("[proto] Booting up gRPC compiler...");

function getProtoFiles(dir, fileList = []) {
    if (!fs.existsSync(dir)) return fileList;
    const files = fs.readdirSync(dir);
    
    for (const file of files) {
        const stat = fs.statSync(path.join(dir, file));
        if (stat.isDirectory()) {
            getProtoFiles(path.join(dir, file), fileList);
        } else if (file.endsWith('.proto')) {
            fileList.push(path.join(dir, file));
        }
    }
    return fileList;
}

async function processFile(filePath) {
    const root = await protobuf.load(filePath);
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const templateSource = fs.readFileSync(TEMPLATE_FILE, 'utf-8');
    const template = Handlebars.compile(templateSource, { noEscape: true });
    
    const portMatch = fileContent.match(/port\s+(\d+)/);
    const defaultPort = portMatch ? parseInt(portMatch[1]) : 100;
    
    // Extract the package name using Regex
    const packageMatch = fileContent.match(/package\s+([^;]+);/);
    // Fallback to service name if no package is defined
    const packageName = packageMatch ? packageMatch[1].trim() : 'unknown_package';
    
    const outputDir = path.dirname(filePath);

    const services = [];
    function findServices(node) {
        if (node instanceof protobuf.Service) services.push(node);
        else if (node.nestedArray) node.nestedArray.forEach(findServices);
    }
    findServices(root);

    for (const service of services) {
        const context = { serviceName: service.name, defaultPort, methods: [], messages: [] };
        const typeNames = new Set();

        for (const [name, method] of Object.entries(service.methods)) {
            context.methods.push({ name, requestType: method.requestType, responseType: method.responseType });
            typeNames.add(method.requestType);
            typeNames.add(method.responseType);
        }

        for (const typeName of typeNames) {
            const type = root.lookupType(typeName);
            const fields = type.fieldsArray.map(field => ({
                name: field.name,
                optional: field.optional ? '?' : '',
                type: field.type === 'string' ? 'string' : field.type === 'bool' ? 'boolean' : 'number'
            }));
            context.messages.push({ name: typeName, fields });
        }

        // Output file is now strictly based on the package name
        const outputFile = path.join(outputDir, `${packageName}.ts`);
        fs.writeFileSync(outputFile, template(context));
        console.log(`[proto] Generated ${outputFile}`);
    }
}

export async function buildProtos() {
    console.log("[proto] Scanning for .proto files...");
    const files = getProtoFiles(SRC_DIR);
    if (files.length === 0) console.log("[proto] No .proto files found in /src.");
    
    for (const file of files) {
        await processFile(file).catch(err => console.error(`[proto] Failed to process ${file}:`, err));
    }
}

buildProtos().catch(console.error);

if (process.argv.includes('--watch')) {
    console.log(`[proto] Watching ${SRC_DIR} for .proto files...`);
    
    const watchPaths = [
        `${SRC_DIR}/**/*.proto`,
        `${SRC_DIR}/*.proto`
    ];

    chokidar.watch(watchPaths, {
        persistent: true,
        ignoreInitial: true
    }).on('change', (filePath) => {
        console.log(`[proto] Saved ${filePath}. Rebuilding...`);
        processFile(filePath).catch(console.error);
    }).on('add', (filePath) => {
        console.log(`[proto] New file ${filePath}. Rebuilding...`);
        processFile(filePath).catch(console.error);
    });
}