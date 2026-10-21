import { readFile } from 'node:fs/promises';
import { parse } from 'parse5';
const errors=[];
parse(await readFile('index.html','utf8'),{onParseError:error=>errors.push(error)});
if(errors.length){
  console.error(errors.map(e=>`${e.code} at ${e.startLine}:${e.startCol}`).join('\n'));
  process.exitCode=1;
}else console.log('HTML parsed without errors');
