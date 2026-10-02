# Сертификаты НУЦ Минцифры (Russian Trusted CA)

Точка.API использует TLS-сертификаты, подписанные Национальным УЦ Минцифры.
В стандартном бандле Node.js этих корней нет → без них запросы падают с
`self-signed certificate in certificate chain`.

Источник (официально у Точки): https://developers.tochka.com/docs/tochka-api/certificate  
PEM с Госуслуг / gu-st.ru:

- `russian_trusted_root_ca_pem.crt`
- `russian_trusted_sub_ca_pem.crt`
- `russian-trusted-ca-bundle.pem` — оба в одном файле (читает `lib/datagonTochkaClient.js`)

Обновить:

```bash
curl -fsSL https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt -o certs/russian_trusted_root_ca_pem.crt
curl -fsSL https://gu-st.ru/content/lending/russian_trusted_sub_ca_pem.crt -o certs/russian_trusted_sub_ca_pem.crt
# LF + bundle
python3 -c "from pathlib import Path
r=Path('certs/russian_trusted_root_ca_pem.crt').read_bytes().replace(b'\\r\\n',b'\\n').replace(b'\\r',b'\\n').decode()
s=Path('certs/russian_trusted_sub_ca_pem.crt').read_bytes().replace(b'\\r\\n',b'\\n').replace(b'\\r',b'\\n').decode()
Path('certs/russian_trusted_root_ca_pem.crt').write_text(r if r.endswith('\\n') else r+'\\n')
Path('certs/russian_trusted_sub_ca_pem.crt').write_text(s if s.endswith('\\n') else s+'\\n')
Path('certs/russian-trusted-ca-bundle.pem').write_text(Path('certs/russian_trusted_root_ca_pem.crt').read_text()+Path('certs/russian_trusted_sub_ca_pem.crt').read_text())"
```

Опционально: `TOCHKA_EXTRA_CA_CERTS=/path/to/bundle.pem` переопределяет путь.
