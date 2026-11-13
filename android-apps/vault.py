#!/usr/bin/env python3
"""안드로이드 업로드 키 보관함

  사용: python3 vault.py <이름> <출력폴더>
  - android-apps/vault/<이름>.enc 가 있으면 풀어서 upload.jks + creds 를 꺼내요
  - 없으면 새 업로드 키를 만들고, 암호화해서 보관함 파일을 만들어요 (NEW_VAULT=1)
  암호화 열쇠는 저장소 Secret(ASC_KEY_P8)에서 만들어서, 저장소가 공개여도 키는 안전해요.
"""
import base64, hashlib, json, os, re, secrets, subprocess, sys

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

name, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
vault = f'android-apps/vault/{name}.enc'
seed = re.sub(r'\s+', '', os.environ['ASC_KEY_P8'])
key = hashlib.sha256(('linkdole-android-vault-v1|' + seed).encode()).digest()
jks = os.path.join(out, 'upload.jks')


def env_out(k, v):
    with open(os.environ['GITHUB_ENV'], 'a') as f:
        f.write(f'{k}={v}\n')


if os.path.exists(vault):
    raw = base64.b64decode(open(vault).read())
    data = json.loads(AESGCM(key).decrypt(raw[:12], raw[12:], None))
    open(jks, 'wb').write(base64.b64decode(data['jks']))
    print('기존 업로드 키 사용')
    env_out('NEW_VAULT', '0')
else:
    pw = secrets.token_urlsafe(24)
    subprocess.run(['keytool', '-genkeypair', '-v', '-keystore', jks, '-storetype', 'JKS', '-alias', 'upload',
                    '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-storepass', pw, '-keypass', pw,
                    '-dname', 'CN=linkdole, OU=apps, O=linkclean, L=Jeju, C=KR'], check=True)
    data = {'jks': base64.b64encode(open(jks, 'rb').read()).decode(), 'pw': pw, 'alias': 'upload'}
    nonce = secrets.token_bytes(12)
    enc = nonce + AESGCM(key).encrypt(nonce, json.dumps(data).encode(), None)
    os.makedirs('android-apps/vault', exist_ok=True)
    open(vault, 'w').write(base64.b64encode(enc).decode())
    print('새 업로드 키를 만들어 보관함에 넣었어요')
    env_out('NEW_VAULT', '1')

print(f"::add-mask::{data['pw']}")
env_out('KS_FILE', jks)
env_out('KS_PASS', data['pw'])
env_out('KS_ALIAS', data['alias'])
