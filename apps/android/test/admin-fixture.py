"""Loopback-only Android settings UI fixture. All changes are in memory; never walks a directory,
contacts a model/provider, or logs request bodies (which could contain test credentials).
adb reverse tcp:37381 tcp:37381; sign in to http://127.0.0.1:37381 as admin or member.
"""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

def user(uid, name, admin=False):
    return dict(id=str(uid),username=name,isAdmin=admin,createdAt='2026-11-11',lastSeenAt=None)

def model(name):
    return dict(id=name,providerID='opencode',name=name,provider='Fixture')

users=[user(1,'admin',True), user(2,'member')]
folders=[dict(id='1',name='Demo',path='/fixture/music',lastScanAt=None)]
scan=dict(state='idle',lastScanAt=None,total=0,processed=0,errors=[])
provider=dict(id='opencode',name='OpenCode',key=True,connected=False,consoleLogin=True,accounts=[])
settings=dict(models=[model('chat-a'),model('chat-b')],voiceModels=[model('voice-a'),model('voice-b')],
              current=dict(providerID='opencode',id='chat-a'),voiceModel='opencode/voice-a',integrations=[provider])
class Handler(BaseHTTPRequestHandler):
    def send(self,status,obj=None,cookie=None):
        body=b'' if status==204 else json.dumps(obj).encode();self.send_response(status)
        self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)))
        if cookie:self.send_header('Set-Cookie','om_session='+cookie+'; Path=/; HttpOnly')
        self.end_headers();self.wfile.write(body)
    def dispatch(self):
        path=urlsplit(self.path).path.removeprefix('/api/v1/');method=self.command
        body=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))) or b'{}')
        if path=='auth/login':
            admin=body.get('username')=='admin';return self.send(200,{'user':users[0 if admin else 1]},'fixture' if admin else 'member')
        cookie=self.headers.get('Cookie','');admin='om_session=fixture' in cookie
        if not admin and 'om_session=member' not in cookie:return self.send(401,{})
        if path=='auth/me':return self.send(200,users[0 if admin else 1])
        if path=='auth/logout':return self.send(204)
        if path=='albums':return self.send(200,dict(items=[],total=0,limit=12,offset=0))
        if path=='plays/summary':return self.send(200,dict(plays=0,tracks=0,listenedSeconds=0))
        if path in ('plays/recent','plays/most-played'):return self.send(200,[])
        if path=='library/scan-status':return self.send(200,scan)
        if not admin:return self.send(403,{'message':'需要管理员权限'})
        if path=='library/scan':scan['state']='scanning' if method=='POST' else 'idle';return self.send(204)
        if path=='music-folders':
            if method=='GET':return self.send(200,folders)
            f=dict(id=str(max((int(i['id']) for i in folders),default=0)+1),lastScanAt=None,**body);folders.append(f);return self.send(200,f)
        if path.startswith('music-folders/'):
            f=next(f for f in folders if f['id']==path.split('/')[-1]);
            if method=='PATCH':f.update(name=body['name']);return self.send(200,f)
            folders.remove(f);return self.send(204)
        if path=='users':
            if method=='GET':return self.send(200,dict(items=users,total=len(users),offset=0,limit=100))
            u=user(max(int(x['id']) for x in users)+1,body['username']);users.append(u);return self.send(200,u)
        if path.startswith('users/'):
            users[:]=[u for u in users if u['id']!=path.split('/')[-1]];return self.send(204)
        if path=='admin/agent/settings':
            if method=='GET':return self.send(200,settings)
            typ=body['type']
            if typ=='model':settings['current']=dict(providerID=body['providerID'],id=body['id'])
            if typ=='voiceModel':settings['voiceModel']=body['providerID']+'/'+body['id']
            if typ=='custom':settings['integrations'].append(dict(id='om-custom-'+body['slug'],name=body['name'],key=True,connected=False,consoleLogin=False,accounts=[]))
            if typ in ('disconnect','key','activate'):
                it=next(x for x in settings['integrations'] if x['id']==body['integrationID']); it['connected']=typ!='disconnect';it['accounts']=[] if typ=='disconnect' else [dict(id='fixture-only',label='测试账号')]
            return self.send(200,settings)
        if path=='admin/agent/console':
            import time
            return self.send(200,dict(attemptID='fixture-1',url='https://opencode.ai/',instructions='测试设备授权',expires=int(time.time()*1000)+300000))
        if path=='admin/agent/console/fixture-1':return self.send(204) if method=='DELETE' else self.send(200,'pending')
        return self.send(404,{'message':'Unknown fixture endpoint'})
    do_GET=do_POST=do_DELETE=do_PATCH=dispatch

if __name__=='__main__':ThreadingHTTPServer(('127.0.0.1',37381),Handler).serve_forever()
