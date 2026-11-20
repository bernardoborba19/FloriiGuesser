-- FloriGuesser: ranking online (opcional). Cole no Supabase: SQL Editor > New query > Run.
-- As tabelas ficam fechadas (RLS ligado, sem políticas); o site só usa as 3 funções abaixo.

create table if not exists public.jogadores (
  nick_key   text primary key,
  nick       text not null,
  senha_hash text not null,
  criado     timestamptz not null default now()
);

create table if not exists public.resultados (
  id          bigint generated always as identity primary key,
  nick_key    text not null references public.jogadores(nick_key),
  cidade      text not null,
  dificuldade text not null,
  total       int  not null check (total between 0 and 25000),
  criado      timestamptz not null default now()
);
create index if not exists resultados_rank_idx on public.resultados (cidade, dificuldade, total desc);

alter table public.jogadores  enable row level security;
alter table public.resultados enable row level security;

create or replace function public.entrar(p_nick text, p_hash text)
returns text language plpgsql security definer set search_path = public as $$
declare k text := lower(trim(p_nick)); h text;
begin
  if char_length(k) < 3 or char_length(k) > 16 or p_hash !~ '^[0-9a-f]{16,128}$' then return 'invalido'; end if;
  select senha_hash into h from public.jogadores where nick_key = k;
  if h is null then
    insert into public.jogadores(nick_key, nick, senha_hash) values (k, trim(p_nick), p_hash);
    return 'criado';
  end if;
  if h = p_hash then return 'ok'; end if;
  return 'senha_incorreta';
end $$;

create or replace function public.salvar_resultado(p_nick text, p_hash text, p_cidade text, p_dificuldade text, p_total int)
returns text language plpgsql security definer set search_path = public as $$
declare k text := lower(trim(p_nick));
begin
  if not exists (select 1 from public.jogadores where nick_key = k and senha_hash = p_hash) then return 'nao_autorizado'; end if;
  if p_cidade not in ('todas', 'Florianópolis', 'São José', 'Palhoça') then return 'cidade_invalida'; end if;
  if p_dificuldade not in ('facil', 'medio', 'dificil', 'misto') then return 'modo_invalido'; end if;
  if p_total < 0 or p_total > 25000 then return 'pontos_invalidos'; end if;
  insert into public.resultados(nick_key, cidade, dificuldade, total) values (k, p_cidade, p_dificuldade, p_total);
  return 'ok';
end $$;

create or replace function public.ranking(p_cidade text, p_dificuldade text, p_limite int default 20)
returns table(nick text, total int, criado timestamptz)
language sql security definer set search_path = public as $$
  select t.nick, t.total, t.criado from (
    select distinct on (r.nick_key) j.nick, r.total, r.criado
    from public.resultados r join public.jogadores j on j.nick_key = r.nick_key
    where r.cidade = p_cidade and r.dificuldade = p_dificuldade
    order by r.nick_key, r.total desc, r.criado
  ) t
  order by t.total desc, t.criado
  limit least(greatest(p_limite, 1), 100)
$$;

revoke all on function public.entrar(text, text)                          from public;
revoke all on function public.salvar_resultado(text, text, text, text, int) from public;
revoke all on function public.ranking(text, text, int)                    from public;
grant execute on function public.entrar(text, text)                          to anon;
grant execute on function public.salvar_resultado(text, text, text, text, int) to anon;
grant execute on function public.ranking(text, text, int)                    to anon;
