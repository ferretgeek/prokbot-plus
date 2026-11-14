// Inspect the stock UI and compare every release recipe with its authenticated source.
// This never imports vendor code, writes a recipe, or asserts end-to-end compatibility.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectRecipe } from './recipe-pin.mjs';

const root = fileURLToPath(new URL('../',import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function hashFile(file) {
  const h=createHash('sha256'); for await (const block of createReadStream(file)) h.update(block); return h.digest('hex');
}
export async function audit(platform,archive,expectedVersion,expectedDigest) {
  assert.ok(['windows','mac'].includes(platform)); assert.match(expectedVersion,/^\d+\.\d+\.\d+$/);
  assert.match(expectedDigest,/^[a-f0-9]{64}$/); assert.equal(await hashFile(archive),expectedDigest,'ASAR fingerprint mismatch');
  const asar=createRequire(path.join(root,'mac/patchers/desktop/package.json'))('@electron/asar');
  const raw=asar.getRawHeader(archive), names=new Map();
  const walk=(dir,prefix='')=>{
    for(const [name,node] of Object.entries(dir)) {
      assert.ok(name && name!=='.' && name!=='..' && !/[\\/\0]/.test(name));
      const p=prefix+name;
      if(node.files)walk(node.files,`${p}/`);else if(!node.link && !node.unpacked)names.set(p,node);
    }
  };
  walk(raw.header.files);
  const bytes = name => {
    const n=names.get(name); assert.ok(n && n.size<=64*1024*1024, 'unknown, external or oversized member');
    const buf=asar.extractFile(archive,path.normalize(name)); assert.equal(buf.length,n.size);
    if(n.integrity) { assert.equal(n.integrity.algorithm,'SHA256'); assert.equal(sha(buf),n.integrity.hash); }
    return buf;
  };
  const pkg=JSON.parse(bytes('package.json')); assert.equal(pkg.version,expectedVersion,'original internal version mismatch');
  const directory=path.join(root,platform,'patchers/desktop/recipes');
  const manifest=JSON.parse(await readFile(path.join(directory,'manifest.json'),'utf8')); assert.equal(manifest.schema,'grokbot-desktop-recipes/v1');
  const inputs=new Map();
  for(const entry of manifest.files) {
    assert.match(entry.recipe,/^[\w.-]+\.gz$/);
    const pin=inspectRecipe(await readFile(path.join(directory,entry.recipe)),entry.recipe,entry);
    const source=entry.source===undefined?entry.path:entry.source;
    if(source===null) {assert.equal(pin.input,sha(Buffer.alloc(0)));continue;}
    const actual=names.has(source)?sha(bytes(source)):null;
    const record={expected:pin.input,actual,status:actual===null?'missing':actual===pin.input?'unchanged':'changed'};
    if(inputs.has(source))assert.deepEqual(inputs.get(source),record);else inputs.set(source,record);
  }
  const members={};
  for(const name of ['dist/renderer/index.html','dist/electron-preload/preload.cjs','dist/electron-preload/preload-vnc.cjs'])
    members[name]=names.has(name)?sha(bytes(name)):null;
  const html=bytes('dist/renderer/index.html').toString('utf8');
  for(const tag of html.matchAll(/<script\b[^>]*>/gi)) {
    const local=/\bsrc\s*=\s*['"]\.\/(assets\/[\w.-]+\.js)['"]/i.exec(tag[0]);
    if(local) {const name=`dist/renderer/${local[1]}`;members[name]=sha(bytes(name));}
  }
  return {platform,version:pkg.version,asarSha256:expectedDigest,headerSha256:sha(raw.headerString),
    recipeSources:inputs.size,counts:Object.fromEntries(['unchanged','changed','missing'].map(state=>[state,[...inputs.values()].filter(x=>x.status===state).length])),
    members,inputs:Object.fromEntries(inputs),runtimeTested:false};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);
  if(args.length!==4) {console.error('Usage: node ci/desktop-source-audit.mjs windows|mac <stock.asar> <internal-version> <verified-asar-sha256>');process.exitCode=2;}
  else audit(...args).then(report=>console.log(JSON.stringify(report,null,2))).catch(err=>{console.error(err.message);process.exitCode=1;});
}
