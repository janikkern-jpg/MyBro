-- 0005_chat_images.sql
-- Bild-Anhänge in beiden Chat-Modi (MyBro + Smalltalk).
--
-- 1) messages-Tabelle (MyBro) erhält image_url (bei st_messages existiert
--    das Feld bereits seit 0002/0004).
-- 2) Storage-Bucket "chat-images" wird als PUBLIC angelegt (Bilder werden
--    per obfuscated Path {user_id}/{uuid}.jpg gespeichert und im Chat per
--    URL gerendert). Write-Access ist per RLS strikt auf den eigenen
--    Unterordner beschränkt – niemand kann in fremde Ordner schreiben.
--
-- Kann beliebig oft ausgeführt werden.

-- =========================================================================
-- MyBro-Nachrichten: image_url ergänzen
-- =========================================================================
alter table public.messages
  add column if not exists image_url text;

-- =========================================================================
-- Storage-Bucket chat-images
-- =========================================================================
-- public=true, damit signed URLs nicht bei jedem Reload neu erzeugt werden
-- müssen. Die Sicherheit stützt sich auf (a) unauffindbare UUIDs im Pfad
-- und (b) strikte Write-Policies pro user_id-Ordner (siehe unten).
insert into storage.buckets (id, name, public)
values ('chat-images', 'chat-images', true)
on conflict (id) do update set public = excluded.public;

-- =========================================================================
-- Storage-Policies (storage.objects)
-- =========================================================================
-- Struktur: {user_id}/{uuid}.jpg – (storage.foldername(name))[1] liefert
-- den ersten Ordner-Teil, den wir gegen auth.uid() vergleichen.

drop policy if exists "chat_images_read_public" on storage.objects;
create policy "chat_images_read_public"
  on storage.objects for select
  using (bucket_id = 'chat-images');

drop policy if exists "chat_images_insert_own_folder" on storage.objects;
create policy "chat_images_insert_own_folder"
  on storage.objects for insert
  with check (
    bucket_id = 'chat-images'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "chat_images_update_own_folder" on storage.objects;
create policy "chat_images_update_own_folder"
  on storage.objects for update
  using (
    bucket_id = 'chat-images'
    and auth.uid()::text = (storage.foldername(name))[1]
  )
  with check (
    bucket_id = 'chat-images'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "chat_images_delete_own_folder" on storage.objects;
create policy "chat_images_delete_own_folder"
  on storage.objects for delete
  using (
    bucket_id = 'chat-images'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

-- PostgREST-schema cache aktualisieren
notify pgrst, 'reload schema';
