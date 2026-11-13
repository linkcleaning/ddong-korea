#!/usr/bin/env python3
"""App Store Connect 상태 확인 (다른 앱 아이폰 빌드용)

  - 번들 ID가 등록돼 있는지 보고, 없으면 등록해요
  - 그 번들 ID로 만든 앱(App Store Connect '나의 앱')이 있는지 확인해요
    → 없으면 업로드를 건너뛰고, 사장님이 앱을 만들어야 한다고 기록해요
결과는 GITHUB_OUTPUT 의 app_exists=1/0 과 status 파일로 남겨요.
"""
import json, os, sys, time

import jwt
import requests

API = 'https://api.appstoreconnect.apple.com/v1'
BUNDLE = os.environ['BUNDLE_ID']
NAME = os.environ.get('APP_NAME_EN', BUNDLE.split('.')[-1])
OUT = os.environ.get('STATUS_FILE', 'asc-status.txt')


def session():
    now = int(time.time())
    key = os.environ['ASC_KEY_P8'].strip()
    tok = jwt.encode({'iss': os.environ['ASC_ISSUER_ID'], 'iat': now, 'exp': now + 1100, 'aud': 'appstoreconnect-v1'},
                     key, algorithm='ES256', headers={'kid': os.environ['ASC_KEY_ID'], 'typ': 'JWT'})
    s = requests.Session()
    s.headers.update({'Authorization': f'Bearer {tok}', 'Content-Type': 'application/json'})
    return s


def main():
    s = session()
    lines = []
    r = s.get(f'{API}/bundleIds', params={'filter[identifier]': BUNDLE, 'limit': 20}, timeout=60)
    r.raise_for_status()
    found = [b for b in r.json()['data'] if b['attributes']['identifier'] == BUNDLE]
    if found:
        lines.append(f'번들 ID {BUNDLE}: 이미 등록됨')
    else:
        body = {'data': {'type': 'bundleIds', 'attributes': {'identifier': BUNDLE, 'name': NAME, 'platform': 'IOS'}}}
        r = s.post(f'{API}/bundleIds', data=json.dumps(body), timeout=60)
        lines.append(f'번들 ID {BUNDLE}: 새로 등록 ({r.status_code}) {r.text[:300] if r.status_code >= 400 else ""}')

    r = s.get(f'{API}/apps', params={'filter[bundleId]': BUNDLE, 'limit': 5}, timeout=60)
    r.raise_for_status()
    apps = r.json()['data']
    exists = bool(apps)
    if exists:
        a = apps[0]['attributes']
        lines.append(f"App Store Connect 앱: 있음 — {a.get('name')} (id {apps[0]['id']})")
    else:
        lines.append('App Store Connect 앱: 없음 → 나의 앱 → + → 신규 앱에서 이 번들 ID로 만들어야 업로드돼요')

    print('\n'.join(lines))
    with open(OUT, 'w') as f:
        f.write('\n'.join(lines) + '\n')
    with open(os.environ['GITHUB_OUTPUT'], 'a') as f:
        f.write(f'app_exists={"1" if exists else "0"}\n')


if __name__ == '__main__':
    try:
        main()
    except Exception as e:  # 확인이 실패해도 빌드는 계속
        print('확인 실패:', e)
        with open(OUT, 'w') as f:
            f.write(f'확인 실패: {e}\n')
        with open(os.environ['GITHUB_OUTPUT'], 'a') as f:
            f.write('app_exists=1\n')  # 모르면 업로드를 시도해 봐요
        sys.exit(0)
