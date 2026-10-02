-- ============================================================================
-- New COA certificates — Sept 2026
-- ============================================================================
-- Attaches 8 newly uploaded COA PDFs (Supabase `certificates` bucket) to their
-- products. Retatrutide = the "GLP-3" products; each Reta COA is applied to
-- both the vial and the Pen of the same strength.
--
-- The new URL is PREPENDED to products.coa_url, so it becomes coa_url[0] (the
-- one the product page opens by default). Older COAs stay in the array, so
-- their existing lab_results rows keep resolving to the product.
--
-- A lab_results row is seeded per new report so it shows on /lab-results.
-- Compound / purity / dates are left null; fill in from Admin → Lab Results.
--
-- Idempotent: safe to run multiple times.
-- ============================================================================

begin;

create temp table _new_coas (product_id uuid, url text, label text) on commit drop;

insert into _new_coas (product_id, url, label) values
  -- GHK(Cu) 50mg (CU50)
  ('f05fa51c-8547-4381-a1da-9be071c6f962', 'https://xbpdqpmdecsoshzttthl.supabase.co/storage/v1/object/public/certificates/ghkcu50mgCOA_VytaBiosciences_Final.pdf', 'GHK-CU 50MG'),
  -- KLOW 80mg (KLOW)
  ('0bfc6211-3390-4478-b895-e96bdafa3e7f', 'https://xbpdqpmdecsoshzttthl.supabase.co/storage/v1/object/public/certificates/VYTA_KLOW_80mg_COA_v2.pdf', 'KLOW 80MG'),
  -- MOTS C 40mg (MS40)
  ('b1443576-b8e1-4b33-94d5-99bf947cf349', 'https://xbpdqpmdecsoshzttthl.supabase.co/storage/v1/object/public/certificates/VYTA_MOTS-C_40mg_COA.pdf', 'MOTS-C 40MG'),
  -- NAD 1000mg (NAD1000)
  ('afe514ff-bcc5-4ef2-aaf4-22b6eeaca5e0', 'https://xbpdqpmdecsoshzttthl.supabase.co/storage/v1/object/public/certificates/VYTA_NADplus_1000mg_COA.pdf', 'NAD+ 1000MG'),
  -- GLP-3 10mg (RT10) + GLP-3 10mg Pen (RT10(P))
  ('be7bb0cc-5e46-4b26-939f-9527b675219d', 'https://xbpdqpmdecsoshzttthl.supabase.co/storage/v1/object/public/certificates/VYTA_Retatrutide_10mg_COA.pdf', 'RETATRUTIDE 10MG'),
  ('cfe1ad37-6053-4207-a087-0f87b6c11a40', 'https://xbpdqpmdecsoshzttthl.supabase.co/storage/v1/object/public/certificates/VYTA_Retatrutide_10mg_COA.pdf', 'RETATRUTIDE 10MG'),
  -- GLP-3 20mg (RT20) + GLP-3 20mg Pen (RT20(P))
  ('aea525cb-4292-4e4b-ba11-41f6e397a055', 'https://xbpdqpmdecsoshzttthl.supabase.co/storage/v1/object/public/certificates/VYTA_Retatrutide_20mg_COA.pdf', 'RETATRUTIDE 20MG'),
  ('dce72daa-949a-4b2c-9fc3-0471ccde104e', 'https://xbpdqpmdecsoshzttthl.supabase.co/storage/v1/object/public/certificates/VYTA_Retatrutide_20mg_COA.pdf', 'RETATRUTIDE 20MG'),
  -- GLP-3 30mg (RT30) + GLP-3 30mg Pens (RT30(P))
  ('ae88b72c-64f9-405b-8679-5972da8bf825', 'https://xbpdqpmdecsoshzttthl.supabase.co/storage/v1/object/public/certificates/VYTA_Retatrutide_30mg_COA.pdf', 'RETATRUTIDE 30MG'),
  ('368cd0b7-273b-4ace-adf8-2c44d5c327c2', 'https://xbpdqpmdecsoshzttthl.supabase.co/storage/v1/object/public/certificates/VYTA_Retatrutide_30mg_COA.pdf', 'RETATRUTIDE 30MG'),
  -- Tesa 10mg (TSM10)
  ('1cbcea9a-5e40-472e-aaec-4e6cd7b36222', 'https://xbpdqpmdecsoshzttthl.supabase.co/storage/v1/object/public/certificates/VYTA_Tesamorelin_10mg_COA.pdf', 'TESAMORELIN 10MG');

-- 1. Prepend the new COA to each product's coa_url (skip if already present).
update public.products p
   set coa_url = array_prepend(n.url, coalesce(p.coa_url, '{}'::text[]))
  from _new_coas n
 where p.id = n.product_id
   and not (n.url = any (coalesce(p.coa_url, '{}'::text[])));

-- 2. One lab_results row per distinct report.
insert into public.lab_results (report_url, product_name)
select distinct url, label from _new_coas
on conflict (report_url) do nothing;

commit;

-- Verify:
-- select p.sku, p.name, p.coa_url[1] as primary_coa, array_length(p.coa_url, 1) as n
--   from public.products p
--  where p.id in ('f05fa51c-8547-4381-a1da-9be071c6f962','0bfc6211-3390-4478-b895-e96bdafa3e7f',
--                 'b1443576-b8e1-4b33-94d5-99bf947cf349','afe514ff-bcc5-4ef2-aaf4-22b6eeaca5e0',
--                 'be7bb0cc-5e46-4b26-939f-9527b675219d','cfe1ad37-6053-4207-a087-0f87b6c11a40',
--                 'aea525cb-4292-4e4b-ba11-41f6e397a055','dce72daa-949a-4b2c-9fc3-0471ccde104e',
--                 'ae88b72c-64f9-405b-8679-5972da8bf825','368cd0b7-273b-4ace-adf8-2c44d5c327c2',
--                 '1cbcea9a-5e40-472e-aaec-4e6cd7b36222');
