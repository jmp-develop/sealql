const repo='cipherstash/encrypt-query-language';
const tree=await (await fetch(`https://api.github.com/repos/${repo}/git/trees/main?recursive=1`)).json() as any;
console.log('commit',tree.sha);
const paths=tree.tree.filter((x:any)=>/match.*\.sql$|bloom.*\.sql$/.test(x.path)).map((x:any)=>x.path);
console.log(paths.slice(0,30));
for(const path of paths.filter((p:string)=>!p.includes('test')).slice(0,3)){
 const url=`https://raw.githubusercontent.com/${repo}/${tree.sha}/${path}`;console.log(url);console.log((await (await fetch(url)).text()).slice(0,10000));
}
