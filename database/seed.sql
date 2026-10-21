-- Fictional demo entities. INNs are generated with valid control digits.
DO $$
DECLARE i INTEGER; j INTEGER; k INTEGER; s TEXT; n INTEGER; weights INTEGER[]=ARRAY[2,4,10,3,5,9,4,6,8];
  cid UUID; aid UUID; pid UUID; st TEXT;
  names TEXT[]=ARRAY['ООО «Гарден Девелопмент»','ООО «Северный квартал»','ООО «Монолит Групп»','ООО «Проектное бюро Сад»','ООО «Новые территории»','ООО «Горизонт Строй»','ООО «Альфа Снабжение»','ООО «Архив Проект»','ООО «Зелёная линия»','ООО «Инженерные решения»'];
  titles TEXT[]=ARRAY['Жилой квартал «Садовый»','Деловой центр «Горизонт»','Школа в Северном районе','Логистический парк «Вектор»','Жилой дом «Зелёная линия»'];
BEGIN
  FOR i IN 1..10 LOOP
    cid=('10000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid;
    s='99000'||lpad(i::text,4,'0'); n=0;
    FOR k IN 1..9 LOOP n=n+substr(s,k,1)::integer*weights[k]; END LOOP;
    s=s||((n%11)%10)::text;
    st=CASE WHEN i<=4 OR i=10 THEN 'ACTIVE' WHEN i=7 THEN 'REJECTED' WHEN i=8 THEN 'ARCHIVED' ELSE 'PENDING_REVIEW' END;
    INSERT INTO contractors(id,full_name,inn,kpp,status,legal_address)
      VALUES(cid,names[i],s,'990001001',st,'Демонстрационный адрес: ул. Садовая, д. '||i)
      ON CONFLICT(id) DO NOTHING;
    FOR j IN 1..CASE WHEN i<=3 THEN 2 ELSE 1 END LOOP
      aid=('20000000-0000-4000-8000-'||lpad((i*10+j)::text,12,'0'))::uuid;
      INSERT INTO contractor_bank_accounts(id,contractor_id,bank_name,bik,account_number,correspondent_account,currency,is_primary)
        VALUES(aid,cid,CASE WHEN j=1 THEN 'Демо Банк «Развитие»' ELSE 'Демо Банк «Резерв»' END,
        '044000001','40702810'||lpad((i*10+j)::text,12,'0'),'30101810000000000001','RUB',j=1)
        ON CONFLICT(id) DO NOTHING;
    END LOOP;
  END LOOP;
  FOR i IN 1..5 LOOP
    pid=('30000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid;
    INSERT INTO projects(id,name,address,city,customer_id,intermediary_id,contractor_id,start_date,end_date,tep)
      VALUES(pid,titles[i],'Демонстрационный адрес: проспект Строителей, участок '||i,
      CASE WHEN i%2=0 THEN 'Санкт-Петербург' ELSE 'Москва' END,
      '10000000-0000-4000-8000-000000000001',
      CASE WHEN i%2=0 THEN '10000000-0000-4000-8000-000000000004'::uuid ELSE NULL END,
      CASE WHEN i=3 THEN '10000000-0000-4000-8000-000000000002'::uuid ELSE '10000000-0000-4000-8000-000000000003'::uuid END,
      ('2026-0'||i||'-01')::date,('2028-0'||i||'-28')::date,
      jsonb_build_array(jsonb_build_object('name','Общая площадь','value',10000+i*2500,'unit','м²'),jsonb_build_object('name','Этажность','value',5+i,'unit','этажей')))
      ON CONFLICT(id) DO NOTHING;
  END LOOP;
END $$;
