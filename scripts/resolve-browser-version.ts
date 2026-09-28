import { CamoufoxFetcher } from 'camoufox-js/dist/pkgman.js';
import { appendFileSync } from 'node:fs';
import { retryCollection } from '../src/core/retry-collection';
const deadline=Number(process.env.COLLECTOR_END_AT);
if(!Number.isFinite(deadline)||deadline<=0)throw Error('Invalid session deadline');
const version=await retryCollection(async()=>{
  const fetcher=new CamoufoxFetcher();await fetcher.init();return fetcher.verstr;
},{deadline,phase:()=> 'browser_release',report:event=>console.log(JSON.stringify(event))});
if(!version)process.exit(1);
appendFileSync(process.env.GITHUB_OUTPUT!,`version=${version}\n`);
