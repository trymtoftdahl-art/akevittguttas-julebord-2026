# Lag QR-kode for den faktiske adressen til nettsiden (etter oppstart/publisering).
# Eksempel: python lag_qr.py http://192.168.1.40:8787
import sys
try:
    import qrcode
except ImportError:
    print('Installer først: pip install qrcode[pil]')
    raise SystemExit(1)
if len(sys.argv)!=2 or not sys.argv[1].startswith(('http://','https://')):
    print('Bruk: python lag_qr.py https://DIN-ADRESSE.NO')
    raise SystemExit(1)
qr=qrcode.QRCode(box_size=12,border=4,error_correction=qrcode.constants.ERROR_CORRECT_Q)
qr.add_data(sys.argv[1]);qr.make(fit=True)
qr.make_image(fill_color='#071a15',back_color='white').save('AKEVITTGUTTAS_QR.png')
print('Ferdig: AKEVITTGUTTAS_QR.png')
