(function(){
'use strict';
var $=function(s){return document.querySelector(s)};
var SAMPLE='<span class="pill o">sample, to be set by policy</span>';
var SITES=[
 {id:'dpdp',host:'dpdp.veridian-aios.com',name:'DPDP Compliance',icon:'🛡️',price:'Plans from the DPDP price list',disc:10,rate:'15%'},
 {id:'mom',host:'mom.veridian-aios.com',name:'MOM (Minutes of Meeting)',icon:'📝',price:'Rs 499 / month (up to 10 people) or Rs 4,999 / 12 months',disc:10,rate:'15%'},
 {id:'aios',host:'veridian-aios.com',name:'Veridian AI OS',icon:'🧭',price:'Per proposal',disc:0,rate:'10%'},
 {id:'tam',host:'home.corporatetambola.com',name:'Corporate Tambola',icon:'🎯',price:'Per event pack',disc:5,rate:'12%'},
 {id:'voter',host:'voterlist.townhall-records.com',name:'Voter List',icon:'🗳️',price:'Per society',disc:0,rate:'10%'},
 {id:'th',host:'townhall-records.com',name:'Townhall Records',icon:'🏛️',price:'Per society / year',disc:0,rate:'10%'},
 {id:'el',host:'elections.townhall.com',name:'Elections',icon:'✅',price:'Per election',disc:5,rate:'10%'},
 {id:'mt',host:'meetings.townhall.com',name:'Meetings',icon:'📅',price:'Per society / year',disc:0,rate:'10%'}
];
var ROLES={
 master:{n:'Owner + AI (Master)',i:'👑',d:'Create policies, codes, schemes; approve partners; see AI actions.',s:['dash','policy','codes','schemes','approve','ai','logs']},
 refer:{n:'Refer and Earn',i:'🎁',d:'Users and players. Share freely, verify later to get paid.',s:['dash','links','earn','logs']},
 manager:{n:'Sales Manager',i:'🧑‍💼',d:'Salary + target + incentive. Team: Team Leaders, Executives, Partners.',s:['dash','team','links','schemes','earn','logs']},
 leader:{n:'Sales Team Leader',i:'🧑‍🏫',d:'Salary + target + incentive. Team: Executives.',s:['dash','team','links','schemes','earn','logs']},
 exec:{n:'Sales Executive',i:'🏃',d:'Target + incentive. Team: Growth Partners.',s:['dash','team','links','schemes','earn','logs']},
 partner:{n:'Growth Partner',i:'🤝',d:'Personal links, codes where allowed, incentive and schemes.',s:['dash','links','schemes','earn','logs']}
};
var SN={dash:'📊 Dashboard',team:'🌳 Team',links:'🔗 Links and codes',schemes:'🏆 Schemes',earn:'💰 Earnings',logs:'📜 Logs',policy:'⚖️ Policies',codes:'🏷️ Codes',approve:'✔️ Approvals',ai:'🤖 AI actions'};
var DATA={
 manager:{sal:'Rs 40,000 (sample)',targets:[['Weekly revenue','Rs 1,20,000',85000,120000],['Growth partners attached','12',7,12],['MOM sales','25',21,25],['Tambola sales','6',2,6]],pay:[['Salary','Rs 40,000'],['Target incentive','Rs 12,000'],['Team override','Rs 3,400']]},
 leader:{sal:'Rs 28,000 (sample)',targets:[['Weekly revenue','Rs 60,000',51000,60000],['Growth partners attached','8',3,8],['DPDP sales','5',1,5]],pay:[['Salary','Rs 28,000'],['Target incentive','Rs 8,000'],['Team override','Rs 1,900']]},
 exec:{sal:'No salary: incentive only (sample)',targets:[['Weekly revenue','Rs 25,000',24000,25000],['Growth partners attached','4',4,4],['MOM sales','10',4,10]],pay:[['Target incentive','Rs 6,500'],['Scheme bonus','Rs 800']]},
 partner:{sal:'No salary: incentive only',targets:[['Sales this month','8',3,8],['New sign-ups','30',22,30]],pay:[['Commission earned','Rs 4,120'],['Scheme bonus','Rs 500']]},
 refer:{sal:'',targets:[['Friends joined','5',2,5]],pay:[['Reward earned','Rs 300'],['Waiting for verification','Rs 300']]},
 master:{sal:'',targets:[['Partners approved this month','40',31,40],['Revenue via partners','Rs 8,00,000',560000,800000]],pay:[['Payouts due (sample)','Rs 1,42,000']]}
};
var SCHEMES=[
 ['Weekly','Sell 3 MOM plans this week','Bonus Rs 300 (sample)','Ends Sun',2,3],
 ['Monthly','Bring 5 new paying customers','Bonus Rs 1,500 (sample)','Ends 30 Nov',3,5],
 ['Quarterly','Reach Rs 3,00,000 revenue','Reward: trip voucher (sample)','Ends 31 Dec',140000,300000]
];
var LOGS=[
 ['09 Nov 10:12','click','MOM link','Delhi, mobile','counted'],
 ['09 Nov 10:40','sign-up','MOM trial','buyer ****42','counted'],
 ['09 Nov 12:05','code use','MOM-RK10','Rs 499 plan','10% off, 1 of 3 uses'],
 ['08 Nov 17:30','sale','MOM 12 months','Rs 4,999','commission held 30 days'],
 ['08 Nov 09:00','payout','Oct statement','Rs 3,200','paid via IT Services + Razorpay (sample)'],
 ['07 Nov 14:22','blocked','Self-referral','same e-mail','not counted']
];
var TEAM={manager:['Anita (Manager, you)',[['Ravi (Team Leader)',[['Sonal (Executive)',[['Partner: Imran',[]],['Partner: Julie',[]]]],['Kabir (Executive)',[['Partner: Neha',[]]]]]],['Meera (Executive, direct)',[['Partner: Arun',[]]]],['Partner: Dev (direct)',[]]]],
 leader:['Ravi (Team Leader, you)',[['Sonal (Executive)',[['Partner: Imran',[]],['Partner: Julie',[]]]],['Kabir (Executive)',[['Partner: Neha',[]]]]]],
 exec:['Sonal (Executive, you)',[['Partner: Imran',[]],['Partner: Julie',[]],['Partner: Tara (pending approval)',[]]]]};
var myCodes=[['MOM-RK10','MOM','10%','buyer: Mr Rao','1 / 3 used','active']];
var st={reg:1,regData:{},log:LOGS.slice()};

function pct(a,b){return Math.min(100,Math.round(a/b*100))}
function cls(p){return p>=80?'g':p>=40?'a':'r'}
function bar(p){return '<div class="bar"><i class="'+cls(p)+'" style="width:'+p+'%"></i></div>'}
function fmt(n){return typeof n==='number'&&n>=1000?'Rs '+n.toLocaleString('en-IN'):n}
function table(h,rows){return '<div class="wrap"><table><tr>'+h.map(function(x){return '<th>'+x+'</th>'}).join('')+'</tr>'+rows.map(function(r){return '<tr>'+r.map(function(c){return '<td>'+c+'</td>'}).join('')+'</tr>'}).join('')+'</table></div>'}
function nav(role,scr){
 return '<div class="tabs">'+ROLES[role].s.map(function(s){return '<a href="#/r/'+role+'/'+s+'" class="'+(s===scr?'on':'')+'">'+SN[s]+'</a>'}).join('')+'</div>'}
function note(){return '<div class="note">Earnings depend on sales. Figures marked sample are placeholders, to be set by policy. No income is guaranteed.</div>'}

var V={};
V.dash=function(r){
 var d=DATA[r],h='<h1>'+ROLES[r].i+' '+ROLES[r].n+'</h1><p class="mut">Hello! Here is how this week looks.</p>';
 if(d.sal)h+='<div class="card row"><span>💼 Pay</span><b>'+d.sal+'</b></div>';
 h+='<h2>🎯 Targets vs achieved</h2>';
 d.targets.forEach(function(t){var p=pct(t[2],t[3]);h+='<div class="card"><div class="row"><b>'+t[0]+'</b><span>'+p+'%</span></div>'+bar(p)+'<span class="mut">'+fmt(t[2])+' of '+t[1]+'</span></div>'});
 if(r==='manager'||r==='leader'||r==='exec'){
  h+='<h2>By product and website</h2>'+table(['Site','Target','Done'],SITES.slice(0,4).map(function(s,i){var t=[10,6,4,5][i],dn=[7,2,4,1][i];return [s.icon+' '+s.host,t,'<span class="pill'+(dn/t<.4?' r':'')+'">'+dn+'</span>']}));}
 if(r==='refer')h+='<div class="note">🎁 You can share your link right now. To get paid you verify your e-mail later, when you become an organiser, host or co-host.</div>';
 if(r==='master')h+='<div class="grid"><div class="card"><div class="big">31</div><span class="mut">partners approved</span></div><div class="card"><div class="big">3</div><span class="mut">waiting approval</span></div></div>';
 return h+note()};
V.team=function(r){
 var t=TEAM[r];function li(n){return '<li><span class="node">'+n[0]+'</span>'+(n[1].length?'<ul>'+n[1].map(li).join('')+'</ul>':'')+'</li>'}
 return '<h1>🌳 My team</h1><p class="mut">Everyone who reports up to you.</p><ul class="tree">'+li(t)+'</ul><div class="card"><b>Targets for the team</b><p class="mut">Weekly revenue and number of partners attached, per product and website. Open Dashboard to see progress.</p></div>'};
V.links=function(r){
 var h='<h1>🔗 My links'+(r==='refer'?'':' and codes')+'</h1><p class="mut">One personal link per product, site and page. Every click is logged.</p>';
 SITES.forEach(function(s){
  var h2=s.host+'/?ref='+(r==='refer'?'friend-7K2':'RK-2931');
  h+='<div class="card"><div class="row"><b>'+s.icon+' '+s.name+'</b><button class="btn ghost" data-copy="1">Copy</button></div><div class="code">https://'+h2+'</div><p class="mut">'+s.price+'</p></div>'});
 if(r==='refer')return h+'<div class="note">No e-mail check needed to share. Discount codes are not part of Refer and Earn.</div>';
 h+='<h2>🏷️ Create a discount code for a buyer</h2><div class="card" id="codeBox"><label>Product</label><select id="cSite">'+SITES.map(function(s){return '<option value="'+s.id+'">'+s.name+'</option>'}).join('')+'</select><div id="cForm"></div></div>';
 h+='<h2>My codes</h2><div id="codeList"></div>';
 return h};
V.schemes=function(r){
 var h='<h1>🏆 Schemes</h1><p class="mut">Weekly, monthly and quarterly. Amounts are '+SAMPLE+'</p>';
 SCHEMES.forEach(function(s){var p=pct(s[4],s[5]);h+='<div class="card"><span class="pill">'+s[0]+'</span> <b>'+s[1]+'</b>'+bar(p)+'<div class="row"><span class="mut">'+p+'% done · '+s[3]+'</span><b>'+s[2]+'</b></div></div>'});
 h+='<h2>🥇 Leaderboard (this month)</h2>'+table(['#','Name','Sales'],[[1,'Sonal','14'],[2,'Imran','11'],[3,'You','9'],[4,'Neha','6']]);
 if(r==='master')h+='<h2>➕ New scheme</h2><div class="card"><label>Name</label><input placeholder="e.g. Diwali week sprint"><label>Goal</label><input placeholder="e.g. 5 sales"><label>Reward</label><input placeholder="sample amount"><button class="btn" data-toast="Scheme saved (demo)">Save scheme</button></div>';
 return h+note()};
V.earn=function(r){
 var d=DATA[r],h='<h1>💰 Earnings and payouts</h1>'+table(['Item','Amount (sample)'],d.pay);
 h+='<h2>Payout rules</h2><div class="card"><p>⏳ Commission is held <b>30 days</b> after a sale so refunds can close. '+SAMPLE+'</p><p>📆 Paid once a month, minimum Rs 500. '+SAMPLE+'</p><p>🏦 Paid only through IT Services + Razorpay.</p>'+(r==='refer'?'<p>✅ <b>Before first payout:</b> verify e-mail and mobile.</p><button class="btn alt" data-nav="#/register">Verify now</button>':'')+'</div>';
 h+='<h2>Statements</h2>'+table(['Month','Amount','Status'],[['Oct','Rs 3,200','<span class="pill">Paid</span>'],['Nov','Rs 1,900','<span class="pill o">Held</span>']]);
 return h+note()};
V.logs=function(){
 return '<h1>📜 Activity log</h1><p class="mut">Clicks, sign-ups, sales, payouts, code uses, blocked items.</p>'+table(['When','Type','What','Detail','Result'],st.log)};
V.policy=function(){
 return '<h1>⚖️ Discount and commission policy</h1><p class="mut">Partners see a discount option <b>only</b> where it is allowed here.</p>'+table(['Site','Max discount','Commission'],SITES.map(function(s){return [s.icon+' '+s.host,s.disc?'up to '+s.disc+'%':'<span class="pill r">none</span>',s.rate+' <span class="mut">sample</span>']}))+
 '<div class="card"><b>Anti-fraud rules (sample)</b><p>• Buyer same e-mail/mobile as partner: not counted<br>• Each code: max 3 uses, expires in 30 days<br>• 14-day protection when a partner registers a prospect<br>• Spikes get a manual check before payout</p></div><button class="btn" data-toast="Policy saved (demo)">Edit and save</button>'+note()};
V.codes=function(){
 return '<h1>🏷️ All codes</h1>'+table(['Code','Site','Off','Owner','Uses'],[['MOM-RK10','MOM','10%','Partner Imran','1/3'],['TAM-EVT5','Tambola','5%','Exec Sonal','4/10'],['DPDP-WELCOME','DPDP','10%','Master','12/100']])+
 '<div class="card"><label>New code (master)</label><input placeholder="CODE"><select>'+SITES.filter(function(s){return s.disc}).map(function(s){return '<option>'+s.name+' (max '+s.disc+'%)</option>'}).join('')+'</select><button class="btn" data-toast="Code created (demo)">Create</button></div>'};
V.approve=function(){
 return '<h1>✔️ Partner approvals</h1><p class="mut">E-mail and mobile already verified by code.</p>'+['Tara Nair · Pune · tara@example.test','Vikram S · Jaipur · vikram@example.test','Asha M · Surat · asha@example.test'].map(function(p){return '<div class="card"><b>'+p+'</b><p><button class="btn alt" data-toast="Approved (demo)">Approve</button> <button class="btn ghost" data-toast="Rejected (demo)">Reject</button></p></div>'}).join('')};
V.ai=function(){
 return '<h1>🤖 AI actions</h1><div class="card"><b>AI access</b><p>Scoped API key <span class="code">ai-key-••••7f3a</span> (masked). Can: draft codes, propose schemes, flag fraud. Cannot: change policy limits, approve payouts, see bank details.</p><p class="mut">Every call is written to the audit log below. Owner can switch it off any time.</p></div>'+
 table(['When','Action','Result'],[['09 Nov 11:02','Drafted code TAM-EVT5 (5%)','waiting for owner'],['09 Nov 09:15','Flagged partner for self-referral','held'],['08 Nov 18:40','Proposed Diwali sprint scheme','owner approved'],['08 Nov 10:00','Tried to raise MOM discount to 20%','refused: above policy']])};
V.home=function(){
 var h='<h1>Welcome to Partner Circle</h1><p>One place for every site: share, earn, grow. 🌱</p><div class="card"><b>New here?</b><p class="mut">Register as a Growth Partner in 4 easy steps.</p><a class="btn" href="#/register">Register</a></div><h2>Owner review: pick a role view</h2>';
 Object.keys(ROLES).forEach(function(k){h+='<a class="card role" href="#/r/'+k+'/dash"><b>'+ROLES[k].i+' '+ROLES[k].n+'</b><p class="mut">'+ROLES[k].d+'</p></a>'});
 h+='<h2>Sites covered</h2><div class="card">'+SITES.map(function(s){return s.icon+' '+s.host}).join('<br>')+'</div>';
 return h+note()};
V.register=function(){
 var s=st.reg,h='<h1>🤝 Become a Growth Partner</h1><div class="step">'+[1,2,3,4].map(function(i){return '<b class="'+(i<=s?'on':'')+'">'+i+'</b>'}).join('')+'</div>';
 if(s===1)h+='<div class="card"><b>Step 1 · About you</b><label>Full name</label><input id="rn"><label>E-mail (needed to verify and log in)</label><input id="re" type="email"><label>Mobile number (needed)</label><input id="rm" type="tel" inputmode="numeric"><button class="btn" id="n1">Send codes</button><p class="mut" id="err"></p></div>';
 if(s===2)h+='<div class="card"><b>Step 2 · Verify</b><p class="mut">Demo code is <b>123456</b>. No real message is sent.</p><label>Code</label><input id="rc" inputmode="numeric" maxlength="6"><button class="btn" id="n2">Verify</button><p class="mut" id="err"></p></div>';
 if(s===3)h+='<div class="card"><b>Step 3 · Choose what you will promote</b>'+SITES.map(function(x){return '<p><label><input type="checkbox" checked style="width:auto"> '+x.icon+' '+x.name+'</label></p>'}).join('')+'<label><input type="checkbox" style="width:auto"> I agree to the partner rules (no self-referral, honest claims)</label><button class="btn" id="n3">Submit for approval</button></div>';
 if(s===4)h+='<div class="card"><b>🎉 Step 4 · Done</b><p>Thank you, '+(st.regData.n||'friend')+'! Your request is with the team. Your personal links appear after approval.</p><p class="mut">Payout details and KYC are asked later, before your first payout.</p><a class="btn alt" href="#/r/partner/dash">See the partner view</a></div>';
 return h+note()};

function router(){
 var h=location.hash||'#/home',m=h.match(/^#\/r\/(\w+)\/(\w+)/),app=$('#app'),rb=$('#roleBar');
 if(m&&ROLES[m[1]]){
  var r=m[1],s=ROLES[r].s.indexOf(m[2])<0?'dash':m[2];
  rb.hidden=false;rb.innerHTML='<span class="mut">Role (review only):</span>'+Object.keys(ROLES).map(function(k){return '<a href="#/r/'+k+'/dash" class="'+(k===r?'on':'')+'">'+ROLES[k].i+' '+ROLES[k].n+'</a>'}).join('');
  app.innerHTML=nav(r,s)+V[s](r);
  if(s==='links'&&r!=='refer')initCodes();
 }else{
  rb.hidden=true;
  if(h==='#/register'){app.innerHTML=V.register();initReg()}else app.innerHTML=V.home();
 }
 window.scrollTo(0,0)}
function toast(t){var d=document.createElement('div');d.textContent=t;d.style.cssText='position:fixed;bottom:14px;left:50%;transform:translateX(-50%);background:#1c2b3a;color:#fff;padding:8px 14px;border-radius:99px;font-size:13px;z-index:9';document.body.appendChild(d);setTimeout(function(){d.remove()},1600)}
function initReg(){
 var e=$('#err');function bad(t){e.textContent=t;e.style.color='#d9534f'}
 var b=$('#n1');if(b)b.onclick=function(){var n=$('#rn').value.trim(),em=$('#re').value.trim(),mo=$('#rm').value.replace(/\D/g,'');
  if(!n)return bad('Please enter your name.');if(!/^\S+@\S+\.\S+$/.test(em))return bad('E-mail is required.');if(mo.length<10)return bad('Enter a 10-digit mobile number.');
  st.regData={n:n,e:em};st.reg=2;router()};
 b=$('#n2');if(b)b.onclick=function(){if($('#rc').value!=='123456')return bad('Wrong code. In this demo use 123456.');st.reg=3;router()};
 b=$('#n3');if(b)b.onclick=function(){st.reg=4;router()}}
function initCodes(){
 var sel=$('#cSite'),f=$('#cForm');
 function draw(){var s=SITES.filter(function(x){return x.id===sel.value})[0];
  if(!s.disc){f.innerHTML='<p class="mut">No discount is available for this product. Share your link as it is.</p>';return}
  f.innerHTML='<label>Discount: <span id="dv">'+s.disc+'</span>% (max allowed '+s.disc+'%)</label><input id="dr" type="range" min="1" max="'+s.disc+'" value="'+s.disc+'"><label>Buyer name or note</label><input id="db" placeholder="e.g. Mr Rao"><button class="btn" id="dc">Create code</button><p class="mut">Max 3 uses, valid 30 days.</p>';
  $('#dr').oninput=function(){$('#dv').textContent=this.value};
  $('#dc').onclick=function(){var c=s.id.toUpperCase()+'-RK'+Math.floor(10+Math.random()*89);myCodes.push([c,s.name,$('#dr').value+'%','buyer: '+($('#db').value||'-'),'0 / 3 used','active']);st.log.unshift(['09 Nov now','code made',c,$('#dr').value+'% off','created']);list();toast('Code '+c+' created. Give it to the buyer.')}}
 function list(){$('#codeList').innerHTML=table(['Code','Product','Off','For','Uses'],myCodes.map(function(c){return ['<span class="code">'+c[0]+'</span>',c[1],c[2],c[3],c[4]]}))}
 sel.onchange=draw;draw();list()}
document.addEventListener('click',function(e){var t=e.target;
 if(t.dataset.copy){t.textContent='Copied ✓';setTimeout(function(){t.textContent='Copy'},1200)}
 if(t.dataset.toast)toast(t.dataset.toast);if(t.dataset.nav)location.hash=t.dataset.nav});
window.addEventListener('hashchange',router);router();
})();
