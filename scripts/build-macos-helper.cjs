'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
function buildMacHelper(){
  if(process.platform!=='darwin')return null;
  const root=path.resolve(__dirname,'..'),source=path.join(root,'electron/native/typed-keys-macos.m');
  const directory=path.join(root,'artifacts/native');
  const binary=path.join(directory,`typed-keys-macos-${process.arch}`),stamp=binary+'.sha256';
  const digest=crypto.createHash('sha256').update(fs.readFileSync(source)).update(process.arch).update('clang-macos10.15-v1').digest('hex');
  if(fs.existsSync(binary)&&fs.existsSync(stamp)&&fs.readFileSync(stamp,'utf8')===digest)return binary;
  fs.mkdirSync(directory,{recursive:true});
  const temporary=binary+'.tmp';
  try{
    execFileSync('/usr/bin/xcrun',['clang','-arch',process.arch==='arm64'?'arm64':'x86_64','-O2','-mmacosx-version-min=10.15','-framework','Foundation','-framework','ApplicationServices','-framework','Carbon',source,'-o',temporary],{stdio:'pipe'});
    execFileSync('/usr/bin/codesign',['--force','--sign','-','--identifier','io.actorf.elysia.typed-keys',temporary],{stdio:'pipe'});
    fs.renameSync(temporary,binary);fs.writeFileSync(stamp,digest);
  }catch(error){try{fs.unlinkSync(temporary);}catch{}throw new Error('Mac 按键助手编译失败。源码运行需要 Xcode Command Line Tools。'+(error.stderr?.toString()||error.message));}
  return binary;
}
module.exports={buildMacHelper};
if(require.main===module){try{const file=buildMacHelper();if(file)console.log(file);}catch(error){console.error(error.message);process.exitCode=1;}}
