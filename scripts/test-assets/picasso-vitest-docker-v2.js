import { translateVitestReport, matchesVitestDependencyBinding } from "../../src/domain/vitest-report-contract.js";

// Source assembly binds deployment dependency hashes; commands and suite targets
// remain owned by this versioned asset. No host path enters the container asset.
export function createPicassoDockerTestAsset({ packageSha256, lockSha256 }) {
  if (![packageSha256, lockSha256].every(value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value))) throw new TypeError("Unbound Picasso dependency manifests");
  const body = String.raw`
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process'),crypto=require('node:crypto');
const root='/artifacts/workspace',deps='/opt/picasso-deps/node_modules';
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
if(!matches(hash('/workspace/package.json'),hash('/workspace/yarn.lock'),'__PACKAGE_SHA__','__LOCK_SHA__')){console.error('Product dependency manifest differs from approved derived snapshot');process.exit(69);}
fs.cpSync('/workspace',root,{recursive:true,dereference:false});
fs.mkdirSync(path.join(root,'node_modules'));
const linked=spawnSync('/bin/sh',['-c','for item in "$1"/*; do ln -s "$item" "$2/" || exit; done','link-readonly-deps',deps,path.join(root,'node_modules')],{stdio:'inherit'});if(linked.status!==0)process.exit(linked.status||1);
const reportPath='/artifacts/vitest-results.json';
const targets=['src/views/analysis/onh/utils/__tests__/transformONHAngle.spec.ts','src/views/analysis/onh/utils/__tests__/useONHHook.spec.ts','src/views/analysis/onh/multiple/store/__tests__/multiONHSync.spec.ts','src/views/analysis/onh/store/__tests__/onhStoreApiParams.spec.ts','src/views/analysis/components/saveImage/store/__tests__/setBscanWidth.spec.ts','src/utils/__tests__/requestScheduler.spec.ts'];
const result=spawnSync(process.execPath,[path.join(root,'node_modules/vitest/vitest.mjs'),'run',...targets,'--reporter=json','--outputFile='+reportPath,'--maxWorkers=1','--minWorkers=1'],{cwd:root,env:{...process.env,HOME:'/tmp',NO_COLOR:'1'},encoding:'utf8',maxBuffer:8*1024*1024});
process.stderr.write((result.stdout||'').slice(-65536));process.stderr.write((result.stderr||'').slice(-65536));
if(result.error){console.error(result.error);process.exit(1);}if(!fs.existsSync(reportPath)){console.error('Missing actual Vitest JSON report');process.exit(result.status||1);}
const translated=translate(fs.existsSync(reportPath)?fs.readFileSync(reportPath,'utf8'):null,result.status);process.stdout.write(translated.stdout);console.error(translated.diagnostic);process.exit(translated.exitCode);
`.replaceAll("__PACKAGE_SHA__", packageSha256).replaceAll("__LOCK_SHA__", lockSha256);
  const helper = "const translate=(" + translateVitestReport.toString() + ");const matches=(" + matchesVitestDependencyBinding.toString() + ");\n" + body;
  // Vite checks ancestor workspace markers. These permissions cover only the
  // container image/read-only source mount; writes stay in the two tmpfs mounts.
  const nodeOptions = "--permission --allow-child-process --allow-worker --allow-addons --allow-fs-read=* --allow-fs-write=/artifacts --allow-fs-write=/tmp";
  const source = 'import {spawnSync} from "node:child_process";\nconst helper=' + JSON.stringify(helper) + ';\nconst nodeOptions=' + JSON.stringify(nodeOptions) + ';\nconst result=spawnSync(process.execPath,["-e",helper],{stdio:"inherit",env:{...process.env,NODE_OPTIONS:nodeOptions}});\nprocess.exitCode=result.error?1:result.status??1;\n';
  return { schemaVersion: 1, title: "Picasso ONH/save/scheduler regression", description: "Six original product Vitest suites, 106 assertions. Linux dependency image binds the original package/lock and offline private UI dist snapshots. No complete product, GUI, e2e or hardware coverage.", version: 2, source };
}
