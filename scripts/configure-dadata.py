#!/usr/bin/env python3
"""Interactive administrator helper: API key is never passed in argv or printed."""
from pathlib import Path
import getpass
import re
import subprocess

root = Path(__file__).resolve().parent.parent
env = root / '.env'
key = getpass.getpass('API-ключ DaData (ввод скрыт; пустая строка — отмена): ').strip()
if not key:
    raise SystemExit('Настройка отменена, конфигурация не изменена.')
if not re.fullmatch(r'[A-Za-z0-9_-]{20,256}', key):
    raise SystemExit('Неверный формат ключа. Конфигурация не изменена.')
lines = env.read_text().splitlines() if env.exists() else []
lines = [line for line in lines if not re.match(r'^\s*(DADATA_API_KEY|INN_LOOKUP_PROVIDER)\s*=', line)]
lines.append('DADATA_API_KEY=' + key)
lines.append('INN_LOOKUP_PROVIDER=dadata')
env.touch(mode=0o600, exist_ok=True)
env.chmod(0o600)
env.write_text('\n'.join(lines) + '\n')
print('Ключ сохранён в локальном .env; значение не выводится.')
subprocess.run(['docker','compose','up','-d','--wait','backend','frontend'], cwd=root, check=True)
print('Подключение настроено. Проверьте поиск по ИНН в форме нового контрагента.')
