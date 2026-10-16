#!/usr/bin/env python3
"""
同步滚动的回归测试（真实浏览器 + 真实滚轮）。

为什么必须用真实滚轮：dispatchEvent 造的合成事件不经过 React 18 的根事件委托，
React 的 onScroll 收不到，会得到「同步没生效」的假象。只有 CDP 的
Input.dispatchMouseEvent 产生的可信事件才会走完整链路。

用法：
  1) 先构建：npx tsc -p tsconfig.json && node scripts/build-client.mjs
  2) 用 /tmp/synctest 里的脚手架生成 wheel.html（见 README「验证」一节）
  3) python3 -m http.server 24899 --bind 127.0.0.1   （在页面目录内）
  4) chrome --headless --remote-debugging-port=24990 http://127.0.0.1:24899/wheel.html
  5) python3 scripts/test-scroll-sync.py

期望：在编辑栏滚动后两侧比例一致；在预览栏滚动后两侧比例同样一致。
"""
import json,os,socket,struct,base64,time
from urllib.parse import urlparse
ws=open('/tmp/cdpw/ws.txt').read().strip(); u=urlparse(ws)
s=socket.create_connection((u.hostname,u.port),timeout=40)
key=base64.b64encode(os.urandom(16)).decode()
s.sendall((f"GET {u.path} HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\nUpgrade: websocket\r\n"
 f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
r=b''
while b'\r\n\r\n' not in r: r+=s.recv(4096)
def send(o):
    d=json.dumps(o).encode(); h=bytearray([0x81]); n=len(d)
    if n<126: h.append(0x80|n)
    elif n<65536: h.append(0x80|126); h+=struct.pack('>H',n)
    else: h.append(0x80|127); h+=struct.pack('>Q',n)
    m=os.urandom(4); h+=m
    s.sendall(bytes(h)+bytes(b^m[i%4] for i,b in enumerate(d)))
def recv(t=30):
    s.settimeout(t)
    try: b=s.recv(2)
    except socket.timeout: return None
    if not b: return None
    ln=b[1]&0x7f
    if ln==126: ln=struct.unpack('>H',s.recv(2))[0]
    elif ln==127: ln=struct.unpack('>Q',s.recv(8))[0]
    d=b''
    while len(d)<ln: d+=s.recv(ln-len(d))
    if b[0]&0x0f==8: return None
    return json.loads(d.decode('utf-8','replace'))
def ev(e,mid,wait=30):
    send({"id":mid,"method":"Runtime.evaluate","params":{"expression":e,"returnByValue":True,"awaitPromise":True}})
    while True:
        m=recv(wait)
        if m is None: return None
        if m.get('id')==mid: return m['result']['result'].get('value') if 'result' in m else None
send({"id":1,"method":"Runtime.enable"}); time.sleep(0.5)
# 等页面 READY
for _ in range(30):
    if ev("!!window.__ed",2): break
    time.sleep(1)
print("就绪:", ev("!!window.__ed && !!window.__pv",3))
print("尺寸:", ev("window.__edMax+'/'+window.__pvMax",4))

def wheel_at(x,y,dy):
    send({"id":100,"method":"Input.dispatchMouseEvent","params":{"type":"mouseMoved","x":x,"y":y}})
    send({"id":101,"method":"Input.dispatchMouseEvent","params":{"type":"mouseWheel","x":x,"y":y,"deltaX":0,"deltaY":dy}})
    time.sleep(0.15)

# 在编辑栏（左半边）滚 5 次
for _ in range(6): wheel_at(300, 400, 300)
time.sleep(1.2)
print("① 在编辑栏滚轮后: ed="+str(ev("window.__ed.scrollTop",10))+" pv="+str(ev("window.__pv.scrollTop",11)))
print("   比例 ed="+str(ev("(window.__ed.scrollTop/window.__edMax*100).toFixed(1)",12))+"% pv="+str(ev("(window.__pv.scrollTop/window.__pvMax*100).toFixed(1)",13))+"%")

# 在预览栏（右半边）往上滚
for _ in range(6): wheel_at(950, 400, -300)
time.sleep(1.2)
print("② 在预览栏滚轮后: ed="+str(ev("window.__ed.scrollTop",14))+" pv="+str(ev("window.__pv.scrollTop",15)))
print("   比例 ed="+str(ev("(window.__ed.scrollTop/window.__edMax*100).toFixed(1)",16))+"% pv="+str(ev("(window.__pv.scrollTop/window.__pvMax*100).toFixed(1)",17))+"%")
