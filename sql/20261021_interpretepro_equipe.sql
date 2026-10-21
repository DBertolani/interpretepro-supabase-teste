-- IntérpretePro: tabela de equipe por usuário.
-- Execute no SQL Editor do projeto Supabase de HOMOLOGAÇÃO antes de testar a equipe.

create table if not exists public.interpretepro_equipe (
  id uuid primary key default gen_random_uuid(),
  email_usuario text not null,
  auth_user_id uuid,
  nome_interprete text not null,
  created_at timestamptz not null default now(),
  constraint interpretepro_equipe_nome_nao_vazio
    check (length(btrim(nome_interprete)) > 0)
);

create unique index if not exists interpretepro_equipe_usuario_nome_uidx
  on public.interpretepro_equipe (
    lower(btrim(email_usuario)),
    lower(btrim(nome_interprete))
  );

alter table public.interpretepro_equipe enable row level security;

grant select, insert, update, delete
  on public.interpretepro_equipe to authenticated;

drop policy if exists interpretepro_equipe_proprio_usuario
  on public.interpretepro_equipe;

create policy interpretepro_equipe_proprio_usuario
  on public.interpretepro_equipe
  for all
  to authenticated
  using (
    lower(btrim(email_usuario)) =
    lower(btrim((select auth.jwt() ->> 'email')))
  )
  with check (
    lower(btrim(email_usuario)) =
    lower(btrim((select auth.jwt() ->> 'email')))
  );

-- Diagnóstico somente de leitura: mostra como os intérpretes estão registrados
-- nos serviços já migrados. Não altera nenhum dado.
select
  email_usuario,
  coalesce(nullif(btrim(interprete), ''), '(vazio)') as interprete,
  count(*) as quantidade_servicos
from public.interpretepro_registros_gerais
group by email_usuario, coalesce(nullif(btrim(interprete), ''), '(vazio)')
order by email_usuario, quantidade_servicos desc;
