"""Loopback-only emulator test fixture; adb reverse tcp:37381 tcp:37381. No external services.
Log in with any test credentials. /_deliver and /_reconnect exercise inbox and SSE recovery.
"""
import json
import queue
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

sessions = [dict(id='ses_fixture', title='测试：下载中', createdAt='2026-11-11'), dict(id='ses_other', title='第二段', createdAt='2026-11-11')]
messages = {'ses_fixture': [dict(id='u',role='user',text='导入示例',createdAt=''),dict(id='a',role='assistant',text='',createdAt='',parts=[
    dict(type='text',ordinal=0,text='开始 **导入**。'),dict(type='tool',id='call',name='execute',status='done',calls=[dict(name='youtube.start_import',status='done')]),
    dict(type='text',ordinal=1,text='| 曲目 | 状态 |\n|---|---|\n| 夜航 | 已入库 |')])]}
inboxes={}; streams=set(); lock=threading.Lock(); seq=0
def emit(event):
    with lock:
        for stream in streams: stream.put(event)

class Handler(BaseHTTPRequestHandler):
    def send(self,status,obj,cookie=False):
        body=json.dumps(obj).encode() if status!=204 else b''
        self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)))
        if cookie:self.send_header('Set-Cookie','om_session=fixture; Path=/; HttpOnly')
        self.end_headers();self.wfile.write(body)
    def dispatch(self):
        global seq
        path=urlsplit(self.path).path;method=self.command
        body=self.rfile.read(int(self.headers.get('content-length',0)))
        # Manually gated: the device test observes each prefix before permitting the next.
        # Nothing from this reply is served by GET /messages (including after completion).
        if method=='POST' and path in ('/_delta/1','/_delta/2','/_delta/3','/_delta/end'):
            ref=dict(sessionID='ses_fixture',messageID='delta_probe',ordinal=0)
            chunks=('鼓点','响起','了。')
            step=path.rsplit('/',1)[1]
            if step=='end':
                emit(dict(type='message.snapshot',text=''.join(chunks),**ref))
                emit(dict(type='raw',event=dict(type='session.execution.succeeded',data=dict(sessionID=ref['sessionID']))))
            else:
                if step=='1':emit(dict(type='raw',event=dict(type='session.execution.started',data=dict(sessionID=ref['sessionID']))))
                emit(dict(type='message.delta',append=chunks[int(step)-1],**ref))
            return self.send(204,{})
        if path=='/_reconnect':emit(None);return self.send(204,{})
        if path=='/_deliver':
            sid=sessions[0]['id']
            for x in inboxes.pop(sid,[]):messages.setdefault(sid,[]).append(dict(role='user',createdAt='',id=x['id'],text=x['text']))
            emit(dict(type='inbox.changed',sessionID=sid,delivered=True));return self.send(204,{})
        if path=='/_action':
            emit(dict(type='client-action',kind='enqueue',sessionID='ses_fixture',tracks=[dict(id='12',title='夜航',artist='Sample',album='Sample',durationSeconds=60)]));return self.send(204,{})
        if path.endswith('/auth/login'):return self.send(200,{'user':dict(id='1',username='demo',createdAt='')},True)
        if 'om_session=fixture' not in self.headers.get('cookie',''):return self.send(401,{})
        if path.endswith('/agent/events'):
            q=queue.Queue()
            with lock:streams.add(q)
            self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
            try:
                while True:
                    try:
                        event=q.get(timeout=2)
                        if event is None:break
                        data='data: '+json.dumps(event)+'\n\n'
                    except queue.Empty:data=': keepalive\n\n'
                    self.wfile.write(data.encode());self.wfile.flush()
            except (BrokenPipeError,ConnectionResetError):pass
            finally:
                with lock:streams.discard(q)
            return
        if path.endswith('/transcribe') and method=='POST':return self.send(200 if body else 400,{'text':'测试听写'})
        if path.endswith('/tracks/12'):return self.send(200,dict(id='12',title='夜航',artist=dict(id='1',name='Sample'),album=dict(id='1',name='Sample'),durationSeconds=60))
        if path.endswith('/agent/sessions'):
            if method=='GET':return self.send(200,sessions)
            seq+=1;s=dict(id=f'ses_{seq}',title='新对话',createdAt='');sessions.append(s);return self.send(200,s)
        if '/agent/sessions/' in path:
            sid,op,*tail=path.split('/agent/sessions/')[1].split('/');items=inboxes.setdefault(sid,[])
            if op=='messages':return self.send(200,messages.get(sid,[]))
            if op=='inbox' and method=='GET':return self.send(200,dict(busy=sid=='ses_fixture',items=items))
            if op=='prompt':seq+=1;items.append(dict(id=f'p_{seq}',**json.loads(body)))
            if tail:
                item=next((i for i in items if i['id']==tail[0]),None)
                if not item:return self.send(404,{})
                if method=='PATCH':item.update(json.loads(body))
                if method=='DELETE':items.remove(item)
            emit(dict(type='inbox.changed',sessionID=sid,delivered=False));return self.send(204,{})
        if path.endswith('/albums'):return self.send(200,dict(items=[],total=0,limit=12,offset=0))
        if path.endswith('/plays/summary'):return self.send(200,dict(plays=0,tracks=0,listenedSeconds=0))
        return self.send(200,[])
    do_GET=do_POST=do_PATCH=do_DELETE=dispatch

if __name__=='__main__': ThreadingHTTPServer(('127.0.0.1',37381),Handler).serve_forever()
