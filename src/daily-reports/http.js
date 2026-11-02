const {validDate}=require('./summary');
function error(status,code,message){throw Object.assign(new Error(message),{status,code});}
async function handleDailyReports({req,res,url,user,reports,writeEnabled,publicOrigin,readBody,reply}){
  if(!user.permissions.includes('team-services:read'))error(403,'FORBIDDEN','没有报告查看权限');
  if(!reports)error(503,'REPORTS_UNAVAILABLE','每日报告尚未配置');
  const base='/api/evaluation/unified/daily-reports';
  if(url.pathname===base&&req.method==='GET'){
    const page=Number(url.searchParams.get('page')||1);
    if(!Number.isInteger(page)||page<1||page>10000)error(400,'INVALID_PAGE','页码无效');
    return reply(res,200,{...await reports.list(page),canGenerate:writeEnabled&&user.permissions.includes('team-services:write')});
  }
  const match=/^\/api\/evaluation\/unified\/daily-reports\/([^/]+)(\/generate|\/markdown)?$/.exec(url.pathname);
  if(!match||!validDate(match[1]))error(400,'INVALID_DATE','测评日期无效');
  const day=match[1];
  if(match[2]==='/generate'&&req.method==='POST'){
    if(!user.permissions.includes('team-services:write'))error(403,'FORBIDDEN','没有报告生成权限');
    if(req.headers.origin!==publicOrigin||req.headers['sec-fetch-site']==='cross-site')error(403,'INVALID_ORIGIN','请求来源无效');
    if(!writeEnabled)error(503,'REPORT_WRITE_DISABLED','报告生成尚未启用');
    if(!/^[\x21-\x7e]{1,128}$/.test(req.headers['idempotency-key']||''))error(400,'INVALID_KEY','请提供幂等键');
    const input=await readBody(req,1024);
    if(Object.keys(input).length)error(400,'INVALID_INPUT','生成报告请发送空对象');
    try{return reply(res,202,await reports.request(day));}catch(e){if(e.code==='42P01')error(503,'REPORT_MIGRATION_REQUIRED','每日报告存储尚未迁移');throw e;}
  }
  if(req.method!=='GET'||match[2]==='/generate')error(405,'METHOD_NOT_ALLOWED','请求方式不支持');
  let report;
  try{report=await reports.get(day);}catch(e){if(e.code==='42P01')error(503,'REPORT_MIGRATION_REQUIRED','每日报告存储尚未迁移');throw e;}
  if(!report)error(404,'REPORT_NOT_FOUND','尚无该日期的报告');
  if(match[2]==='/markdown'){
    if(!report.markdown||report.status!=='ready')error(409,'REPORT_NOT_READY','报告尚未生成完成');
    res.writeHead(200,{'Content-Type':'text/markdown; charset=utf-8','Content-Disposition':`attachment; filename="daily-evaluation-${day}.md"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(report.markdown);return;
  }
  return reply(res,200,{...report,canGenerate:writeEnabled&&user.permissions.includes('team-services:write')});
}
module.exports={handleDailyReports};
