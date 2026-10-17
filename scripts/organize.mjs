import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectWorkspace, coordinate } from './workspace.mjs';

const hash = b => createHash('sha256').update(b).digest('hex');
const fail = (code, message, details) => { throw Object.assign(new Error(message), { code, details }); };
const exists = p => { try { fs.lstatSync(p); return true; } catch(e) { if(e.code === 'ENOENT') return false; throw e; } };
const key = p => process.platform === 'win32' ? p.toLowerCase() : p;
const inside = (base,p) => { const r=path.relative(base,p); return !path.isAbsolute(r) && r!=='..' && !r.startsWith('..'+path.sep); };
const overlap = (a,b) => inside(key(a),key(b)) || inside(key(b),key(a));
const active = c => !['complete','cancelled'].includes(c.status);
const RESERVED = /^(?:readme(?:\..*)?|agents\.md|claude\.md|license(?:\..*)?|sum\.md|main\.md|workspace\.json|cordis\.ya?ml|package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig(?:\..*)?\.json|jsconfig\.json|(?:vite|webpack|next|eslint)\.config\..*|requirements.*\.txt|pyproject\.toml|cargo\.(?:toml|lock)|go\.(?:mod|sum))$/i;
function id(s) { if(typeof s!=='string'|| !/^[a-z0-9][a-z0-9-]{0,63}$/.test(s)) fail('INPUT','Invalid plan/task id'); return s; }
function who(s) { if(typeof s!=='string'||!s||s==='unknown'||s.length>160||/[\x00-\x1f]/.test(s)) fail('IDENTITY','Actual session id required'); return s; }
function noLinks(base,p) {
  if(!inside(base,p)) fail('PATH','Path outside permitted directory');
  let current=base;
  if(fs.lstatSync(base).isSymbolicLink()) fail('LINK','Linked directory not allowed');
  for(const part of path.relative(base,p).split(path.sep).filter(Boolean)) {
    current=path.join(current,part);
    if(exists(current)&&fs.lstatSync(current).isSymbolicLink()) fail('LINK','Linked path not allowed');
  }
}
function flatSource(ws,rel) {
  if(typeof rel!=='string'||!rel||rel.length>240||/[\x00-\x1f\\/]/.test(rel)||rel==='..'||rel.startsWith('.')||RESERVED.test(rel)) fail('PROTECTED','Only explicit, non-project root artifacts can be organized');
  const p=path.join(ws,rel); noLinks(ws,p); return p;
}
function targetPath(task,rel) {
  if(typeof rel!=='string'||!rel||rel.length>1024||/[\x00-\x1f]/.test(rel)||path.isAbsolute(rel)) fail('PATH','Target must be relative to the task directory');
  const p=path.resolve(task.directory,rel);
  if(p===task.directory||!inside(task.directory,p)||path.relative(task.directory,p).split(path.sep).some(n=>n.startsWith('.'))) fail('PATH','Target escapes task directory or names metadata');
  noLinks(task.directory,p); return p;
}
function fileHash(p) {
  const st=fs.lstatSync(p);
  if(!st.isFile()||st.isSymbolicLink()||st.size>16*1024*1024) fail('FILE','Expected regular file up to 16 MiB');
  const b=fs.readFileSync(p), end=fs.lstatSync(p);
  if(st.size!==end.size||st.mtimeMs!==end.mtimeMs||st.ino!==end.ino) fail('CHANGED','File changed while being read');
  return {sha256:hash(b),size:b.length};
}
function tracked(ws,rel) {
  const r=spawnSync('git',['-C',ws,'ls-files','--error-unmatch','--',rel],{encoding:'utf8',timeout:3000});
  if(r.error||![0,1,128].includes(r.status)) return 'unknown';
  if(r.status===128&&!/not a git repository/i.test(r.stderr||''))return 'unknown';
  return r.status===0?'tracked':'untracked';
}
function page(rows,opt) {
  const offset=Number(opt.offset??0),limit=Number(opt.limit??5);
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>20) fail('INPUT','offset>=0, limit=1..20');
  const n=Math.min(rows.length,offset+limit);
  return {total:rows.length,items:rows.slice(offset,n),more:n<rows.length,...(n<rows.length?{nextOffset:n}:{})};
}
function registryDir(s) {
  const dir=path.join(s.root,'claims');
  noLinks(s.root,dir); fs.mkdirSync(dir,{recursive:true}); return dir;
}
function save(s,c) {
  const dir=registryDir(s), dest=path.join(dir,c.id+'.json'); noLinks(dir,dest);
  const next={...c,rev:(c.rev??0)+1};
  const temp=path.join(dir,'.tmp-'+randomUUID());
  try {fs.writeFileSync(temp,JSON.stringify(next)+'\n',{flag:'wx'});fs.renameSync(temp,dest);}
  finally {if(exists(temp))fs.unlinkSync(temp);}
  Object.assign(c,next);return c;
}
function summarize(c) { return {id:c.id,task:c.task,owner:c.owner,status:c.status,rev:c.rev,count:c.entries.length,digest:c.digest}; }
function taskFor(s,c) {
  const task=s.tasks.find(t=>t.id===c.task);
  if(!task||task.owner!==c.owner||task.directory!==c.directory) fail('TASK_CHANGED','Task ownership/directory changed');
  noLinks(s.workspace,task.directory);
  const sid=path.join(task.directory,'.session-id');noLinks(task.directory,sid);
  if(fs.readFileSync(sid,'utf8').trim()!==task.owner) fail('OWNER','Task directory marker does not match');
  return task;
}
function validatePlan(s,c) {
  if(c.epoch!==s.config.epoch) fail('EPOCH_CHANGED','Coordinator changed; review and replace an unstarted plan');
  const task=taskFor(s,c);
  const original=c.entries.map(e=>({source:e.source,target:e.target,sha256:e.sha256,size:e.size}));
  if(c.digest!==hash(JSON.stringify({id:c.id,task:c.task,owner:c.owner,epoch:c.epoch,directory:c.directory,entries:original}))) fail('PLAN_CHANGED','Plan content no longer matches its confirmation digest');
  for(const e of c.entries) {
    if(flatSource(s.workspace,path.basename(e.source))!==e.source||targetPath(task,path.relative(task.directory,e.target))!==e.target) fail('PATH','Plan path is invalid');
    for(const t of s.tasks.filter(t=>t.id!==c.task&&['planned','doing','blocked'].includes(t.state))) for(const p of t.writes) if(overlap(p,e.source)||overlap(p,e.target)) fail('RESOURCE_CONFLICT','Another task reserves this path');
  }
  return task;
}
function sourceUnchanged(e) {
  if(!exists(e.source)||fileHash(e.source).sha256!==e.sha256) fail('SOURCE_CHANGED','Source changed or disappeared: '+path.basename(e.source));
}
function references(ws,entries) {
  const args=['--files-with-matches','--fixed-strings','--hidden','--no-ignore-vcs'];
  for(const p of ['.git','.workspace','node_modules','.venv','venv','dist','build']) args.push('--glob','!'+p+'/**');
  for(const e of entries) args.push('-e',path.basename(e.source));
  args.push('--','.');
  const r=spawnSync('rg',args,{cwd:ws,encoding:'utf8',timeout:5000,maxBuffer:1024*1024});
  const rows=(r.stdout||'').split(/\r?\n/).filter(Boolean).map(p=>p.replace(/^[.][\\/]/,'').replaceAll('\\','/')).filter(p=>!entries.some(e=>key(p)===key(path.basename(e.source))));
  return {complete:!r.error&&[0,1].includes(r.status),scope:'textual-filename-candidates;dynamic-references-not-proven',files:[...new Set(rows)].slice(0,200),truncated:rows.length>200};
}
function inventory(ws,opt) {
  const s=inspectWorkspace(ws), rows=[];
  for(const ent of fs.readdirSync(s.workspace,{withFileTypes:true})) {
    if(!ent.isFile()||ent.name.startsWith('.')||RESERVED.test(ent.name))continue;
    const p=path.join(s.workspace,ent.name), st=fs.lstatSync(p);
    const plans=s.claims.filter(c=>active(c)&&c.entries.some(e=>key(e.source)===key(p)));
    const candidates=s.tasks.filter(t=>t.writes.some(q=>overlap(q,p))).map(t=>({task:t.id,session:t.owner,evidence:'declared-write;not-proof-of-ownership'}));
    rows.push({file:ent.name,bytes:st.size,ownership:plans.length?'claim-pending':'unknown',...(plans.length?{plans:plans.map(c=>c.id)}:{}),...(candidates.length?{candidates}: {})});
  }
  rows.sort((a,b)=>a.file.localeCompare(b.file));
  return {scope:'root-regular-artifacts;directories-and-project-metadata-excluded',enabled:Boolean(s.config),files:page(rows,opt)};
}
function propose(s,opt) {
  const caller=who(opt.session), input=JSON.parse(fs.readFileSync(path.resolve(opt.file),'utf8'));
  if(!input||Object.keys(input).some(k=>!['id','task','files','evidence'].includes(k)))fail('INPUT','Expected id/task/files/evidence');
  const task=s.tasks.find(t=>t.id===id(input.task));
  if(!task)fail('TASK_REQUIRED','Target conversation must register its own task/directory first');
  if(caller!==s.config.main&&caller!==task.owner)fail('NOT_ALLOWED','Only coordinator or target owner can propose');
  const planId=id(input.id);
  if(s.claims.some(c=>c.id===planId))fail('EXISTS','Plan id already exists');
  if(!Array.isArray(input.files)||!input.files.length||input.files.length>50)fail('INPUT','Plan requires 1..50 explicit files');
  const evidence=input.evidence??[];
  if(!Array.isArray(evidence)||evidence.length>20||evidence.some(x=>typeof x!=='string'||x.length>1024||/[\x00-\x1f]/.test(x)))fail('INPUT','Use at most 20 short evidence references');
  let total=0;const usedSources=new Set(),usedTargets=new Set();
  const entries=input.files.map(f=>{
    if(!f||Object.keys(f).some(k=>!['source','target'].includes(k)))fail('INPUT','Each file requires source and target');
    const source=flatSource(s.workspace,f.source),target=targetPath(task,f.target);
    if(usedSources.has(key(source))||usedTargets.has(key(target)))fail('DUPLICATE','Duplicate source or destination');
    usedSources.add(key(source));usedTargets.add(key(target));
    const git=tracked(s.workspace,f.source);if(git!=='untracked')fail('PROJECT_FILE','Tracked or unclassified files require manual project-level migration');
    if(exists(target))fail('TARGET_EXISTS','Destination already exists');
    for(const c of s.claims.filter(active))for(const e of c.entries)if(overlap(e.source,source)||overlap(e.target,target))fail('CLAIM_CONFLICT','File is already in another pending plan');
    const fingerprint=fileHash(source);total+=fingerprint.size;if(total>64*1024*1024)fail('LIMIT','Plan exceeds 64 MiB');
    return {source,target,...fingerprint,copied:false,removed:false};
  });
  const c={schema:1,id:planId,task:task.id,owner:task.owner,directory:task.directory,epoch:s.config.epoch,status:'proposed',createdBy:caller,evidence,entries};
  const original=entries.map(e=>({source:e.source,target:e.target,sha256:e.sha256,size:e.size}));
  c.digest=hash(JSON.stringify({id:c.id,task:c.task,owner:c.owner,epoch:c.epoch,directory:c.directory,entries:original}));
  validatePlan(s,c);
  c.references=references(s.workspace,entries);save(s,c);
  return {...summarize(c),referenceCandidates:c.references.files.length,referenceScanComplete:c.references.complete&&!c.references.truncated,next:'Target owner reviews detail and accepts this digest'};
}
function getPlan(s,opt,{owner=true,epoch=true}={}) {
  const c=s.claims.find(c=>c.id===id(opt.plan));if(!c)fail('NOT_FOUND','Plan not found');
  if(owner&&who(opt.session)!==c.owner)fail('OWNER','Only the target conversation can accept/copy/finish');
  if(String(c.rev)!==opt['expect-rev'])fail('REVISION','Use the latest plan revision',{rev:c.rev});
  if(epoch)validatePlan(s,c);return c;
}
function detail(s,opt) {
  const c=s.claims.find(c=>c.id===id(opt.plan));if(!c)fail('NOT_FOUND','Plan not found');
  return {...summarize(c),epoch:c.epoch,evidence:c.evidence,files:page(c.entries.map(e=>({source:path.relative(s.workspace,e.source),target:path.relative(s.workspace,e.target),sha256:e.sha256,copied:e.copied,removed:e.removed})),opt),references:{...c.references,files:page(c.references.files,opt)}};
}
function accept(s,opt) {
  const c=getPlan(s,opt);
  if(c.status!=='proposed')fail('STATE','Only a proposed plan can be accepted');
  if(opt.digest!==c.digest)fail('DIGEST','Review the entire plan and pass its digest');
  c.entries.forEach(sourceUnchanged);
  c.status='accepted';c.acceptedBy=c.owner;c.acceptedDigest=c.digest;save(s,c);return summarize(c);
}
function copy(s,opt) {
  const c=getPlan(s,opt);
  if(!['accepted','copying','copied'].includes(c.status)||c.acceptedDigest!==c.digest||c.acceptedBy!==c.owner)fail('STATE','Target owner must accept before copying');
  c.entries.forEach(sourceUnchanged);
  for(const e of c.entries)if(exists(e.target)&&fileHash(e.target).sha256!==e.sha256)fail('TARGET_EXISTS','Destination content differs; preserve it and review');
  if(c.status==='copied')return {...summarize(c),noChanges:true};
  c.status='copying';save(s,c);
  for(const e of c.entries) {
    noLinks(c.directory,e.target);sourceUnchanged(e);
    fs.mkdirSync(path.dirname(e.target),{recursive:true});
    if(!exists(e.target))fs.copyFileSync(e.source,e.target,fs.constants.COPYFILE_EXCL);
    if(fileHash(e.target).sha256!==e.sha256)fail('COPY_CHECK','Copied content differs');
    e.copied=true;save(s,c);
  }
  c.status='copied';save(s,c);return {...summarize(c),originalsRetained:true,next:'Owner fixes/verifies references and tests, then finish with evidence'};
}
function finish(s,opt) {
  const c=getPlan(s,opt);
  if(c.status==='complete')return {...summarize(c),noChanges:true};
  if(c.status!=='copied')fail('STATE','Copy and verify files first');
  if(!opt['remove-originals'])fail('EXPLICIT_MOVE','Pass --remove-originals only when relocation is authorized and verified');
  const checks=JSON.parse(fs.readFileSync(path.resolve(opt.checks),'utf8'));
  if(checks.referencesReviewed!==true||!Array.isArray(checks.checks)||!checks.checks.length||checks.checks.length>20||checks.checks.some(x=>typeof x.name!=='string'||!x.name||x.name.length>160||x.result!=='passed'||typeof x.evidence!=='string'||!x.evidence||x.evidence.length>1024))fail('CHECKS','Provide referencesReviewed=true and passed checks with evidence');
  const verificationKey=hash(JSON.stringify(checks));
  if(c.verification&&c.verification.key!==verificationKey)fail('CHECKS_CHANGED','Resume with the same verification record');
  const targets=[];
  for(const e of c.entries) {
    noLinks(c.directory,e.target);
    const current=fileHash(e.target);
    if(c.verification&&c.verification.targets.find(x=>x.path===e.target)?.sha256!==current.sha256)fail('TARGET_CHANGED','Verified destination changed');
    targets.push({path:e.target,sha256:current.sha256});
    if(exists(e.source))sourceUnchanged(e);
    else if(!c.verification&&!e.removed)fail('SOURCE_CHANGED','Original disappeared before verification');
  }
  if(!c.verification){c.verification={key:verificationKey,checks,targets};save(s,c);}
  for(const e of c.entries) {
    noLinks(c.directory,e.target);
    if(fileHash(e.target).sha256!==targets.find(t=>t.path===e.target).sha256)fail('TARGET_CHANGED','Destination changed during finish');
    if(exists(e.source)){sourceUnchanged(e);fs.unlinkSync(e.source);}
    e.removed=true;save(s,c);
  }
  const task=s.tasks.find(t=>t.id===c.task), record={...task,rev:task.rev+1,updatedAt:new Date().toISOString()};
  record.writes=task.writes.map(p=>c.entries.find(e=>key(e.source)===key(p))?.target??p);
  record.evidence=[...new Set([...task.evidence,`.workspace/claims/${c.id}.json`])].slice(-20);
  const target=path.join(s.root,'tasks',task.id+'.json'),tmp=path.join(s.root,'tasks','.tmp-'+randomUUID());
  try{fs.writeFileSync(tmp,JSON.stringify(record)+'\n',{flag:'wx'});fs.renameSync(tmp,target);}finally{if(exists(tmp))fs.unlinkSync(tmp);}
  c.status='complete';save(s,c);return {...summarize(c),moved:c.entries.length,taskRev:record.rev};
}
function cancel(s,opt) {
  const c=getPlan(s,opt,{owner:false,epoch:false}),caller=who(opt.session);
  if(caller!==c.owner&&caller!==s.config.main)fail('OWNER','Only owner or coordinator can cancel');
  if(c.entries.some(e=>e.removed)||c.verification)fail('PARTIAL_MOVE','Resume finish; some originals may already have been removed');
  c.status='cancelled';save(s,c);return {...summarize(c),copiesRetained:c.entries.filter(e=>e.copied).length};
}
function parse(args) {
  const opt={},allowed=new Set(['workspace','session','file','plan','digest','expect-rev','checks','limit','offset']);
  for(let i=1;i<args.length;i++) {
    const k=args[i].startsWith('--')?args[i].slice(2):'';
    if(k==='remove-originals'){opt[k]=true;continue;}
    if(!allowed.has(k)||k in opt||!args[i+1]||args[i+1].startsWith('--'))fail('INPUT','Unknown/repeated option or missing value');
    opt[k]=args[++i];
  }
  if(!opt.workspace)fail('INPUT','--workspace required');return opt;
}
export function executeOrganize(args) {
  if(!args.length||args[0]==='--help')return {help:'inventory, propose, detail, accept, copy, finish, cancel; see references/organize.md'};
  const opt=parse(args);
  if(args[0]==='inventory')return inventory(opt.workspace,opt);
  const modes={propose,detail,accept,copy,finish,cancel};if(!modes[args[0]])fail('INPUT','Unknown organization command');
  return coordinate(opt.workspace,s=>modes[args[0]](s,opt));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try{console.log(JSON.stringify(executeOrganize(process.argv.slice(2))));}
  catch(e){console.error(JSON.stringify({error:e.code||'ERROR',message:e.message,...(e.details?{details:e.details}:{})}));process.exitCode=2;}
}
