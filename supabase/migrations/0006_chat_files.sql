-- 0006_chat_files.sql
-- Datei-Anhänge, die die Smalltalk-KI per `create_file`-Tool erzeugt
-- (CSV/TXT/JSON/PDF/DOCX). Analog zu chat-images:
--  1) Storage-Bucket "chat-files" (public), Pfad {user_id}/{uuid}.{ext}.
--  2) RLS-Policies wie bei chat-images: Read frei (Pfad ist obfuscated),
--     Write/Update/Delete nur im eigenen Unterordner (auth.uid()).
--
-- Kann beliebig oft ausgeführt werden.

-- =========================================================================
-- Storage-Bucket chat-files
-- =========================================================================
insert into storage.buckets (id, name, public)
values ('chat-files', 'chat-files', true)
on conflict (id) do update set public = excluded.public;

-- =========================================================================
-- Storage-Policies (storage.objects)
-- =========================================================================
drop policy if exists "chat_files_read_public" on storage.objects;
create policy "chat_files_read_public"
  on storage.objects for select
  using (bucket_id = 'chat-files');

drop policy if exists "chat_files_insert_own_folder" on storage.objects;
create policy "chat_files_insert_own_folder"
  on storage.objects for insert
  with check (
    bucket_id = 'chat-files'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "chat_files_update_own_folder" on storage.objects;
create policy "chat_files_update_own_folder"
  on storage.objects for update
  using (
    bucket_id = 'chat-files'
    and auth.uid()::text = (storage.foldername(name))[1]
  )
  with check (
    bucket_id = 'chat-files'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "chat_files_delete_own_folder" on storage.objects;
create policy "chat_files_delete_own_folder"
  on storage.objects for delete
  using (
    bucket_id = 'chat-files'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

-- PostgREST-schema cache aktualisieren
notify pgrst, 'reload schema';
