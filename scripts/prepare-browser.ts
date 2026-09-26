import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {launchOptions} from 'camoufox-js';
import {firefox} from 'playwright-core';

export async function ensureBrowser(probe: () => Promise<void>, install: () => unknown, log: (event: string, values?: {systemInstall?: boolean}) => void) {
  try {
    await probe();
    log('browser-ready', {systemInstall:false});
  } catch(error) {
    const missing = /missing dependencies|error while loading shared libraries|cannot open shared object file/i.test(error instanceof Error ? error.message : '');
    if (!missing) throw new Error('BROWSER_PREFLIGHT_FAILED');
    log('browser-system-dependencies-missing');
    await install();
    try { await probe(); } catch { throw new Error('BROWSER_PREFLIGHT_FAILED_AFTER_INSTALL'); }
    log('browser-ready', {systemInstall:true});
  }
}
async function probe() {
  let browser;
  try {
    browser = await firefox.launch({...await launchOptions({headless:false,geoip:false,locale:'en-GB'}),timeout:30000});
    const page = await browser.newPage();
    await page.setContent('<p>Browser ready</p>');
    if (await page.locator('p').textContent() !== 'Browser ready') throw new Error('RENDER_FAILED');
  } finally {
    await browser?.close();
  }
}
function install() {
  // Use the locked Playwright version; npx playwright would download latest.
  const cli=fileURLToPath(new URL('../node_modules/playwright-core/cli.js',import.meta.url));
  const result=spawnSync(process.execPath,[cli,'install-deps','firefox'],{stdio:'inherit',timeout:300000});
  if(result.error || result.status!==0) throw new Error('SYSTEM_INSTALL_FAILED');
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try { await ensureBrowser(probe,install,(event,values={})=>console.log(JSON.stringify({event,...values}))); }
  catch(error) {
    console.error(JSON.stringify({event:'browser-prepare-failed',code:['BROWSER_PREFLIGHT_FAILED','BROWSER_PREFLIGHT_FAILED_AFTER_INSTALL','SYSTEM_INSTALL_FAILED'].includes(error instanceof Error ? error.message : '') && error instanceof Error?error.message:'PREPARE_FAILED'}));
    process.exitCode=1;
  }
}
