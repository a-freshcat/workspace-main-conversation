import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { execute } from '../scripts/workspace.mjs';
import { executeOrganize } from '../scripts/organize.mjs';

const suite=fs.mkdtempSync(path.join(os.tmpdir(),'organize-skill-test-'));let seq=0;
const args=(command,ws,opts={})=>[command,'--workspace',ws,...Object.entries(opts).flatMap(([k,v])=>v===true?['--'+k]:['--'+k,String(v)])];
const core=(ws,command,opts)=>execute(args(command,ws,opts));
const org=(ws,command,opts)=>executeOrganize(args(command,ws,opts));
const failCode=(fn,code)=>assert.throws(fn,e=>e.code===code);
const input=value=>{const p=path.join(suite,'input-'+ ++seq+'.json');fs.writeFileSync(p,JSON.stringify(value));return p;};
function task(ws,owner='worker',taskId='collect',writes=[]) {return core(ws,'task',{session:owner,file:input({id:taskId,goal:'整理自己的产物',state:'doing',directory:'conversations/'+taskId,writes})});}
function setup() {
  const ws=path.join(suite,'ws-'+ ++seq);fs.mkdirSync(ws);core(ws,'init',{session:'main'});task(ws);
  fs.writeFileSync(path.join(ws,'notes.md'),'artifact content\n');return ws;
}
const plan=(ws,files=[{source:'notes.md',target:'notes/notes.md'}],id='gather')=>org(ws,'propose',{session:'main',file:input({id,task:'collect',files,evidence:['合成测试，负责人另行确认']})});
const readPlan=ws=>JSON.parse(fs.readFileSync(path.join(ws,'.workspace/claims/gather.json'),'utf8'));
const ownerOpts=c=>({session:'worker',plan:c.id,'expect-rev':c.rev});
const accept=(ws,c)=>org(ws,'accept',{...ownerOpts(c),digest:c.digest});
const copy=(ws,c)=>org(ws,'copy',ownerOpts(c));
const checks=()=>input({referencesReviewed:true,checks:[{name:'引用与内容核对',result:'passed',evidence:'合成测试已核对内容、位置和引用'}]});
after(()=>{const p=path.resolve(suite),rel=path.relative(path.resolve(os.tmpdir()),p);if(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel)&&path.basename(p).startsWith('organize-skill-test-'))fs.rmSync(p,{recursive:true,force:true});});

test('inventory is read-only and does not claim existing files',()=>{
  const ws=path.join(suite,'unenabled');fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws,'notes.md'),'x');fs.writeFileSync(path.join(ws,'README.md'),'project');fs.mkdirSync(path.join(ws,'src'));
  const r=org(ws,'inventory');assert.equal(r.enabled,false);assert.equal(r.files.total,1);assert.equal(r.files.items[0].ownership,'unknown');assert.equal(fs.existsSync(path.join(ws,'.workspace')),false);
});
test('proposal enters only the target owner mailbox without moving files',()=>{
  const ws=setup(), c=plan(ws);
  assert.equal(c.status,'proposed');assert.equal(fs.existsSync(path.join(ws,'notes.md')),true);
  assert.equal(core(ws,'context',{session:'worker'}).claims.items[0].id,c.id);
  assert.equal(core(ws,'context',{session:'other'}).claims,undefined);
  assert.equal(core(ws,'context',{session:'main'}).claims.total,1);
});
test('coordinator cannot accept for another conversation and digest/revision are checked',()=>{
  const ws=setup(),c=plan(ws);
  failCode(()=>org(ws,'accept',{session:'main',plan:c.id,'expect-rev':c.rev,digest:c.digest}),'OWNER');
  failCode(()=>org(ws,'accept',{...ownerOpts(c),digest:'wrong'}),'DIGEST');
  failCode(()=>org(ws,'accept',{...ownerOpts(c),'expect-rev':99,digest:c.digest}),'REVISION');
  assert.equal(accept(ws,c).status,'accepted');
});
test('acceptance rejects a changed source',()=>{
  const ws=setup(),c=plan(ws);fs.writeFileSync(path.join(ws,'notes.md'),'changed');failCode(()=>accept(ws,c),'SOURCE_CHANGED');
});
test('copy requires acceptance, verifies bytes and retains originals',()=>{
  const ws=setup(),c=plan(ws);failCode(()=>copy(ws,c),'STATE');
  const copied=copy(ws,accept(ws,c));assert.equal(copied.originalsRetained,true);
  assert.equal(fs.readFileSync(path.join(ws,'conversations/collect/notes/notes.md'),'utf8'),'artifact content\n');
  assert.equal(fs.existsSync(path.join(ws,'notes.md')),true);
  assert.equal(copy(ws,copied).noChanges,true);
});
test('finish needs explicit relocation and verification evidence',()=>{
  const ws=setup(),c=copy(ws,accept(ws,plan(ws)));
  failCode(()=>org(ws,'finish',{...ownerOpts(c),checks:checks()}),'EXPLICIT_MOVE');
  failCode(()=>org(ws,'finish',{...ownerOpts(c),checks:input({referencesReviewed:false,checks:[]}), 'remove-originals':true}),'CHECKS');
  assert.equal(fs.existsSync(path.join(ws,'notes.md')),true);
});
test('missing or unreadable input files report their own code instead of a Node internal error',()=>{
  const ws=setup(),c=copy(ws,accept(ws,plan(ws)));
  // --checks omitted entirely: must not surface ERR_INVALID_ARG_TYPE from path.resolve
  failCode(()=>org(ws,'finish',{...ownerOpts(c),'remove-originals':true}),'CHECKS');
  failCode(()=>org(ws,'finish',{...ownerOpts(c),checks:path.join(suite,'no-such-checks.json'),'remove-originals':true}),'CHECKS');
  const bad=path.join(suite,'bad-'+ ++seq+'.json');fs.writeFileSync(bad,'{not json');
  failCode(()=>org(ws,'finish',{...ownerOpts(c),checks:bad,'remove-originals':true}),'CHECKS');
  // --file omitted on propose
  failCode(()=>org(ws,'propose',{session:'main'}),'INPUT');
  failCode(()=>org(ws,'propose',{session:'main',file:path.join(suite,'no-such-plan.json')}),'INPUT');
  assert.equal(fs.existsSync(path.join(ws,'notes.md')),true);
});
test('verified relocation updates task writes/evidence and resolves the mailbox',()=>{
  const ws=setup();const t=core(ws,'detail',{task:'collect'});
  core(ws,'task',{session:'worker','expect-rev':t.rev,file:input({id:'collect',goal:t.goal,state:t.state,directory:'conversations/collect',writes:['notes.md']})});
  const c=copy(ws,accept(ws,plan(ws))),before=core(ws,'context',{session:'main'});
  const done=org(ws,'finish',{...ownerOpts(c),checks:checks(),'remove-originals':true});
  assert.equal(done.status,'complete');assert.equal(fs.existsSync(path.join(ws,'notes.md')),false);
  const target=path.join(ws,'conversations/collect/notes/notes.md');assert.equal(fs.readFileSync(target,'utf8'),'artifact content\n');
  const taskRecord=core(ws,'detail',{task:'collect'});assert.ok(taskRecord.writes.some(p=>p.toLowerCase()===target.toLowerCase()));assert.ok(taskRecord.evidence.includes('.workspace/claims/gather.json'));
  const after=core(ws,'context',{session:'main',since:before.stamp});assert.deepEqual(after.resolvedClaims.items,['gather']);
  core(ws,'summary',{session:'main'});assert.equal(core(ws,'check').ok,true);
});
test('owner can fix copied relative references before providing verification',()=>{
  const ws=setup(),c=copy(ws,accept(ws,plan(ws)));
  fs.writeFileSync(path.join(ws,'conversations/collect/notes/notes.md'),'updated relative link\n');
  assert.equal(org(ws,'finish',{...ownerOpts(c),checks:checks(),'remove-originals':true}).status,'complete');
});
test('changed originals prevent deletion of any files',()=>{
  const ws=setup(),c=copy(ws,accept(ws,plan(ws)));fs.writeFileSync(path.join(ws,'notes.md'),'new external change');
  failCode(()=>org(ws,'finish',{...ownerOpts(c),checks:checks(),'remove-originals':true}),'SOURCE_CHANGED');assert.equal(fs.existsSync(path.join(ws,'notes.md')),true);
});
test('different destination content is never overwritten',()=>{
  const ws=setup(),c=accept(ws,plan(ws));const target=path.join(ws,'conversations/collect/notes/notes.md');fs.mkdirSync(path.dirname(target));fs.writeFileSync(target,'someone else');
  failCode(()=>copy(ws,c),'TARGET_EXISTS');assert.equal(fs.readFileSync(target,'utf8'),'someone else');
});
test('protected, escaping, duplicate paths and occupied targets are rejected',()=>{
  const ws=setup();fs.writeFileSync(path.join(ws,'README.md'),'project');
  for(const source of ['README.md','../notes.md','.session-id'])failCode(()=>plan(ws,[{source,target:'safe.md'}]),'PROTECTED');
  for(const target of ['../outside.md','.session-id'])failCode(()=>plan(ws,[{source:'notes.md',target}]),'PATH');
  failCode(()=>plan(ws,[{source:'notes.md',target:'a.md'},{source:'notes.md',target:'b.md'}]),'DUPLICATE');
  fs.writeFileSync(path.join(ws,'conversations/collect/occupied.md'),'existing');failCode(()=>plan(ws,[{source:'notes.md',target:'occupied.md'}]),'TARGET_EXISTS');
});
test('Git-tracked files require project-level migration',()=>{
  const ws=setup();assert.equal(spawnSync('git',['init','-q',ws]).status,0);assert.equal(spawnSync('git',['-C',ws,'add','notes.md']).status,0);
  failCode(()=>plan(ws),'PROJECT_FILE');assert.equal(fs.existsSync(path.join(ws,'notes.md')),true);
});
test('target junction cannot escape the registered owner directory',t=>{
  const ws=setup(),outside=path.join(suite,'outside-'+ ++seq);fs.mkdirSync(outside);
  try{fs.symlinkSync(outside,path.join(ws,'conversations/collect/escape'),process.platform==='win32'?'junction':'dir');}
  catch(error){if(process.platform==='win32'&&['EPERM','EACCES'].includes(error.code)){t.skip(`Windows denied junction creation (${error.code})`);return;}throw error;}
  failCode(()=>plan(ws,[{source:'notes.md',target:'escape/notes.md'}]),'LINK');assert.deepEqual(fs.readdirSync(outside),[]);
});
test('pending plan reserves sources against other plans and tasks',()=>{
  const ws=setup();plan(ws);failCode(()=>plan(ws,[{source:'notes.md',target:'other.md'}],'another'),'CLAIM_CONFLICT');
  failCode(()=>task(ws,'worker-two','another',['notes.md']),'RESOURCE_CONFLICT');
});
test('copy recovery accepts identical checkpointed destinations',()=>{
  const ws=setup(),c=copy(ws,accept(ws,plan(ws))),p=path.join(ws,'.workspace/claims/gather.json');
  const journal=readPlan(ws);journal.status='copying';journal.entries[0].copied=false;fs.writeFileSync(p,JSON.stringify(journal));
  assert.equal(copy(ws,c).status,'copied');assert.equal(fs.existsSync(path.join(ws,'notes.md')),true);
});
test('finish recovers after a verified original was removed before its journal update',()=>{
  const ws=setup(),c=copy(ws,accept(ws,plan(ws))),checkFile=checks();const journal=readPlan(ws),e=journal.entries[0];
  const data=JSON.parse(fs.readFileSync(checkFile,'utf8'));journal.verification={key:createHash('sha256').update(JSON.stringify(data)).digest('hex'),checks:data,targets:[{path:e.target,sha256:createHash('sha256').update(fs.readFileSync(e.target)).digest('hex')}]};
  fs.writeFileSync(path.join(ws,'.workspace/claims/gather.json'),JSON.stringify(journal));fs.unlinkSync(e.source);
  assert.equal(org(ws,'finish',{...ownerOpts(c),checks:checkFile,'remove-originals':true}).status,'complete');
});
test('changed verified target is preserved and blocks a resumed finish',()=>{
  const ws=setup(),c=copy(ws,accept(ws,plan(ws))),checkFile=checks(),journal=readPlan(ws),e=journal.entries[0];
  const data=JSON.parse(fs.readFileSync(checkFile,'utf8'));journal.verification={key:createHash('sha256').update(JSON.stringify(data)).digest('hex'),checks:data,targets:[{path:e.target,sha256:createHash('sha256').update(fs.readFileSync(e.target)).digest('hex')}]};
  fs.writeFileSync(path.join(ws,'.workspace/claims/gather.json'),JSON.stringify(journal));fs.writeFileSync(e.target,'external change');
  failCode(()=>org(ws,'finish',{...ownerOpts(c),checks:checkFile,'remove-originals':true}),'TARGET_CHANGED');assert.equal(fs.existsSync(e.source),true);
});
test('epoch changes invalidate unstarted plans and cancellation resolves them',()=>{
  const ws=setup(),c=plan(ws);core(ws,'handoff',{session:'main',to:'new-main','expect-epoch':1});
  failCode(()=>accept(ws,c),'EPOCH_CHANGED');assert.equal(org(ws,'cancel',{...ownerOpts(c)}).status,'cancelled');
});
test('cancelling copied plans retains both copies',()=>{
  const ws=setup(),c=copy(ws,accept(ws,plan(ws)));const r=org(ws,'cancel',ownerOpts(c));
  assert.equal(r.copiesRetained,1);assert.equal(fs.existsSync(path.join(ws,'notes.md')),true);assert.equal(fs.existsSync(path.join(ws,'conversations/collect/notes/notes.md')),true);
});
test('large plan detail is paged while quiet context remains short',()=>{
  const ws=setup();const files=[];for(let i=0;i<7;i++){const f='note-'+i+'.md';fs.writeFileSync(path.join(ws,f),'test');files.push({source:f,target:f});}
  const c=plan(ws,files);const d=org(ws,'detail',{plan:c.id});assert.equal(d.files.more,true);assert.equal(org(ws,'detail',{plan:c.id,offset:5}).files.items.length,2);
  const b=core(ws,'context',{session:'worker'}),quiet=core(ws,'context',{session:'worker',since:b.stamp});assert.equal(quiet.noChanges,true);assert.ok(JSON.stringify(quiet).length<100);
});
