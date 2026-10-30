// Run with Ego Lite's managed task space, not standalone Node.js.
// ego-browser nodejs -e 'await import("file:///absolute/repo/collectors/catalogue/yiigle_collect.mjs")'
// It reads public catalogue DOM only; no cookies or credentials are exported.
const task = await taskSpace('国际中医中药杂志官网复采-'+new Date().toISOString());
const page = task.page('p1');
const fs = await import('node:fs/promises');
const { fileURLToPath } = await import('node:url');
const destination = fileURLToPath(new URL('../../datasets/catalogue/官网补采/', import.meta.url));
await fs.mkdir(destination, {recursive: true});
const months = ['202511','202512',...Array.from({length:10},(_,i)=>'2026'+String(i+1).padStart(2,'0'))];
for (const period of months) {
  const url = 'https://gjzyzyzz.yiigle.com/CN115398'+period+'/index.jhtml?tplReset=qikan';
  await page.goto(url);
  await page.waitForSelector('.current_content_article_body', {state:'attached', timeout:15000});
  const result = await page.evaluate(() => {
    const body = document.body.innerText;
    return {url:location.href,title:document.title,
      issue_date:body.match(/出版日期[：:]\s*(\d{4}-\d{2}-\d{2})/)?.[1] || '',
      articles:[...document.querySelectorAll('.current_content_article_body')].map(node=>{
        const anchor=node.querySelector('.Current_Title a');
        const citation=node.querySelector('.current_tip')?.textContent.trim() || '';
        return {title:anchor?.textContent.trim(),url:anchor?.href,
          authors:node.querySelector('.current_author')?.textContent.trim() || '',citation,
          doi:citation.match(/DOI[：:]\s*(10\.\S+)/i)?.[1] || '',
          pages:citation.match(/\(\d+\)[：:]\s*([\d-]+)/)?.[1] || '',
          year:citation.match(/(20\d{2}),/)?.[1] || '',
          issue:citation.match(/\((\d+)\)/)?.[1] || ''};
      })};
  });
  if (!result.articles.length || result.articles.some(a=>!a.title || a.year!==period.slice(0,4) || Number(a.issue)!==Number(period.slice(4)))) throw new Error('Invalid issue identity '+period);
  if (new Set(result.articles.map(a=>a.url)).size!==result.articles.length) throw new Error('Duplicate publisher IDs');
  result.period=period;
  result.fetched_at=new Date().toISOString();
  await fs.writeFile(destination+'/'+period+'.json',JSON.stringify(result,null,2));
  console.log(period,result.issue_date,result.articles.length);
}
await task.finish({keep:[]});
