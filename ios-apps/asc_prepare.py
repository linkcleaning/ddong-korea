#!/usr/bin/env python3
"""App Store Connect: 새 버전을 '심사 제출 직전'까지 준비해요 (제출은 하지 않아요).

  1) 버전(예: 1.1.0)이 없으면 만들기
  2) 업로드한 빌드가 처리 끝날 때까지 기다렸다가 버전에 붙이기
  3) 한국어 '새로운 기능'·프로모션 문구·설명·키워드 넣기
  4) 아이폰 스크린샷 바꾸기 (폴더가 있으면)
설정: ios-apps/prepare.json
"""
import hashlib, json, os, sys, time

import jwt
import requests

API = 'https://api.appstoreconnect.apple.com/v1'
CFG = json.load(open('ios-apps/prepare.json'))
LOG = []


def log(*a):
    s = ' '.join(str(x) for x in a)
    print(s, flush=True)
    LOG.append(s)


def session():
    now = int(time.time())
    tok = jwt.encode({'iss': os.environ['ASC_ISSUER_ID'], 'iat': now, 'exp': now + 1100, 'aud': 'appstoreconnect-v1'},
                     os.environ['ASC_KEY_P8'].strip(), algorithm='ES256',
                     headers={'kid': os.environ['ASC_KEY_ID'], 'typ': 'JWT'})
    s = requests.Session()
    s.headers.update({'Authorization': f'Bearer {tok}', 'Content-Type': 'application/json'})
    return s


S = session()
T0 = time.time()


def call(method, path, ok=(200, 201, 204), **kw):
    global S, T0
    if time.time() - T0 > 900:
        S, T0 = session(), time.time()
    url = path if path.startswith('http') else API + path
    r = S.request(method, url, timeout=120, **kw)
    if r.status_code not in ok:
        raise RuntimeError(f'[{r.status_code}] {method} {path}\n{r.text[:1500]}')
    return r.json() if r.text else {}


def main():
    app = CFG['app_id']
    ver = CFG['version']
    build_no = str(CFG['build'])

    # 1) 버전
    vs = call('GET', f'/apps/{app}/appStoreVersions', params={'filter[platform]': 'IOS', 'limit': 20})['data']
    for v in vs:
        log('기존 버전:', v['attributes']['versionString'], v['attributes']['appStoreState'])
    v = next((x for x in vs if x['attributes']['versionString'] == ver), None)
    if not v:
        editable = [x for x in vs if x['attributes']['appStoreState'] in ('PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED')]
        if editable:
            v = editable[0]
            call('PATCH', f"/appStoreVersions/{v['id']}", data=json.dumps({'data': {'type': 'appStoreVersions', 'id': v['id'], 'attributes': {'versionString': ver}}}))
            log('편집 중이던 버전을', ver, '로 바꿈')
        else:
            body = {'data': {'type': 'appStoreVersions', 'attributes': {'platform': 'IOS', 'versionString': ver, 'releaseType': CFG.get('release_type', 'AFTER_APPROVAL')},
                             'relationships': {'app': {'data': {'type': 'apps', 'id': app}}}}}
            v = call('POST', '/appStoreVersions', data=json.dumps(body))['data']
            log('새 버전 만듦:', ver)
    vid = v['id']

    # 2) 빌드 기다리기
    build = None
    for i in range(60):
        bs = call('GET', '/builds', params={'filter[app]': app, 'filter[version]': build_no, 'limit': 5})['data']
        if bs:
            st = bs[0]['attributes']['processingState']
            log(f'빌드 {build_no} 상태: {st}')
            if st == 'VALID':
                build = bs[0]
                break
            if st in ('FAILED', 'INVALID'):
                raise RuntimeError('빌드 처리 실패')
        else:
            log(f'빌드 {build_no} 아직 안 보임')
        time.sleep(30)
    if not build:
        raise RuntimeError('빌드 처리가 30분 안에 안 끝남')
    # 암호화 질문 답(수출 규정): 일반 HTTPS만 씀
    try:
        if build['attributes'].get('usesNonExemptEncryption') is None:
            call('PATCH', f"/builds/{build['id']}", data=json.dumps({'data': {'type': 'builds', 'id': build['id'], 'attributes': {'usesNonExemptEncryption': False}}}))
    except Exception as e:
        log('암호화 답 설정 건너뜀:', e)
    call('PATCH', f'/appStoreVersions/{vid}/relationships/build', data=json.dumps({'data': {'type': 'builds', 'id': build['id']}}))
    log('빌드', build_no, '를 버전', ver, '에 붙임')

    # 3) 문구
    locs = call('GET', f'/appStoreVersions/{vid}/appStoreVersionLocalizations')['data']
    for loc in locs:
        log('언어:', loc['attributes']['locale'])
    for locale, texts in CFG['texts'].items():
        loc = next((x for x in locs if x['attributes']['locale'] == locale), None)
        attrs = {k: v for k, v in texts.items() if v}
        if loc:
            call('PATCH', f"/appStoreVersionLocalizations/{loc['id']}", data=json.dumps({'data': {'type': 'appStoreVersionLocalizations', 'id': loc['id'], 'attributes': attrs}}))
            log(locale, '문구 넣음:', ', '.join(attrs))
            locid = loc['id']
        else:
            body = {'data': {'type': 'appStoreVersionLocalizations', 'attributes': {'locale': locale, **attrs},
                             'relationships': {'appStoreVersion': {'data': {'type': 'appStoreVersions', 'id': vid}}}}}
            locid = call('POST', '/appStoreVersionLocalizations', data=json.dumps(body))['data']['id']
            log(locale, '언어 새로 만들고 문구 넣음')

        # 4) 스크린샷
        folder = CFG.get('screenshots_dir')
        if locale == CFG.get('screenshots_locale') and folder and os.path.isdir(folder):
            try:
                upload_shots(locid, folder)
            except Exception as e:
                log('스크린샷 바꾸기 실패(기존 것 유지):', str(e)[:600])


def upload_shots(locid, folder):
    files = sorted(f for f in os.listdir(folder) if f.endswith('.png'))
    sets = call('GET', f'/appStoreVersionLocalizations/{locid}/appScreenshotSets')['data']
    log('스크린샷 묶음:', [s['attributes']['screenshotDisplayType'] for s in sets])
    target_type = CFG.get('display_type', 'APP_IPHONE_67')
    st = next((s for s in sets if s['attributes']['screenshotDisplayType'] == target_type), None)
    if not st:
        body = {'data': {'type': 'appScreenshotSets', 'attributes': {'screenshotDisplayType': target_type},
                         'relationships': {'appStoreVersionLocalization': {'data': {'type': 'appStoreVersionLocalizations', 'id': locid}}}}}
        st = call('POST', '/appScreenshotSets', data=json.dumps(body))['data']
        log('스크린샷 묶음 새로 만듦:', target_type)
    old = call('GET', f"/appScreenshotSets/{st['id']}/appScreenshots")['data']
    new_ids = []
    for f in files:
        p = os.path.join(folder, f)
        data = open(p, 'rb').read()
        body = {'data': {'type': 'appScreenshots', 'attributes': {'fileName': f, 'fileSize': len(data)},
                         'relationships': {'appScreenshotSet': {'data': {'type': 'appScreenshotSets', 'id': st['id']}}}}}
        shot = call('POST', '/appScreenshots', data=json.dumps(body))['data']
        for op in shot['attributes']['uploadOperations']:
            hdr = {h['name']: h['value'] for h in op.get('requestHeaders', [])}
            chunk = data[op['offset']:op['offset'] + op['length']]
            r = requests.request(op['method'], op['url'], headers=hdr, data=chunk, timeout=120)
            if r.status_code >= 300:
                raise RuntimeError(f'조각 올리기 실패 {r.status_code}')
        call('PATCH', f"/appScreenshots/{shot['id']}", data=json.dumps({'data': {'type': 'appScreenshots', 'id': shot['id'],
             'attributes': {'uploaded': True, 'sourceFileChecksum': hashlib.md5(data).hexdigest()}}}))
        new_ids.append(shot['id'])
        log('스크린샷 올림:', f)
    # 새 것이 다 올라간 뒤에만 옛 것 지우기
    for o in old:
        call('DELETE', f"/appScreenshots/{o['id']}")
    if old:
        log('옛 스크린샷', len(old), '장 지움')
    call('PATCH', f"/appScreenshotSets/{st['id']}/relationships/appScreenshots",
         data=json.dumps({'data': [{'type': 'appScreenshots', 'id': i} for i in new_ids]}))


if __name__ == '__main__':
    ok = True
    try:
        main()
        log('✅ 준비 완료 — App Store Connect에서 [심사에 추가/제출]만 누르면 돼요 (제출은 하지 않았어요)')
    except Exception as e:
        ok = False
        log('❌ 멈춤:', str(e)[:2000])
    open(os.environ.get('PREP_LOG', 'prepare.log'), 'w').write('\n'.join(LOG) + '\n')
    sys.exit(0 if ok else 1)
