# landmarks.txt の各建物の位置を OSM の名前から探す → tools/plateau/landmarks.json
import pickle, json, sys
o = pickle.load(open('/home/claude/plateau/osmnames.pkl', 'rb'))
def names(s): return [p.split('=', 1)[1] for p in s.split('\x1f') if '=' in p and ('name' in p.split('=')[0])]
res = []
for line in open('/home/claude/car2026/tools/plateau/landmarks.txt'):
    line = line.strip()
    if not line or line.startswith('#'): continue
    parts = [p.strip() for p in line.split('|')]
    label, keys = parts[0], parts[1:]
    hit = None
    for k in keys:
        if k.startswith('@'):
            la, lo = map(float, k[1:].split(',')); hit = ('pos', '', True, k, (la, lo)); break
        ex = k.startswith('=')
        kk = k.lstrip('=').replace(' ', '')
        c = [x for x in o if 35.645 < x[4][0] < 35.705 and 139.74 < x[4][1] < 139.80 and
             any((n.replace(' ', '') == kk) if ex else (kk in n.replace(' ', '').replace('　', '')) for n in names(x[3]))]
        c.sort(key=lambda x: (not x[2], x[0] == 'node'))
        if c: hit = c[0]; break
    res.append({'label': label, 'found': bool(hit), 'osm': hit and f'{hit[0]}/{hit[1]}', 'lat': hit and hit[4][0], 'lon': hit and hit[4][1],
                'osmName': hit and (names(hit[3]) or [''])[0]})
    print(('OK ' if hit else '-- ') + label, '→', hit and (names(hit[3]) or [''])[0], hit and hit[0], hit and tuple(round(v, 5) for v in hit[4]))
json.dump(res, open('/home/claude/car2026/tools/plateau/landmarks.json', 'w'), ensure_ascii=False, indent=1)
