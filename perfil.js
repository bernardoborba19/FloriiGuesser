/* ==========================================================================
   FloriGuesser — jogadores, resultados salvos e ranking.

   Dois modos, escolhidos automaticamente pelo config.js:
   - Local (padrão): contas e ranking ficam no navegador deste aparelho.
   - Online: se SUPABASE_URL e SUPABASE_ANON_KEY estiverem preenchidos, as
     contas e o ranking são compartilhados por todos (veja README e supabase.sql).
   ========================================================================== */
(function () {
  "use strict";

  var CFG = window.GEO_CONFIG || {};
  var ONLINE = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);
  var K_SESSAO = "floriguesser:sessao";
  var K_USERS = "floriguesser:usuarios";
  var K_SCORES = "floriguesser:resultados";
  var MAX_LOCAL = 500;

  function lget(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lset(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function lparse(k, fallback) { try { return JSON.parse(lget(k)) || fallback; } catch (e) { return fallback; } }

  function nickKey(n) { return String(n || "").trim().toLowerCase(); }

  /** Valida o nome: 3 a 16 caracteres (letras, números, espaço, _ - .). Devolve mensagem de erro ou "". */
  function validarNick(n) {
    n = String(n || "").trim();
    if (n.length < 3 || n.length > 16) return "O nome precisa ter de 3 a 16 caracteres.";
    if (!/^[\p{L}\p{N} _.\-]+$/u.test(n)) return "Use só letras, números, espaço, _ - ou .";
    return "";
  }

  /** SHA-256 (hex) de nome+senha. Sem crypto.subtle (página sem https), usa um hash simples de reserva. */
  function hash(nick, pin) {
    var txt = nickKey(nick) + ":" + pin + ":floriguesser";
    if (window.crypto && window.crypto.subtle && window.TextEncoder) {
      return window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(txt)).then(function (buf) {
        return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
      });
    }
    var h1 = 0x811c9dc5, h2 = 0x01000193;
    for (var i = 0; i < txt.length; i++) { h1 = Math.imul(h1 ^ txt.charCodeAt(i), 16777619) >>> 0; h2 = (Math.imul(h2, 31) + txt.charCodeAt(i)) >>> 0; }
    return Promise.resolve(("00000000" + h1.toString(16)).slice(-8) + ("00000000" + h2.toString(16)).slice(-8));
  }

  /* ---------------- sessão ---------------- */
  function current() {
    var s = lparse(K_SESSAO, null);
    return s && s.nick && s.hash ? { nick: s.nick } : null;
  }
  function sessao() { return lparse(K_SESSAO, null); }
  function sair() { try { localStorage.removeItem(K_SESSAO); } catch (e) { /* ignora */ } }

  /* ---------------- chamada ao Supabase (REST, sem biblioteca) ---------------- */
  function rpc(fn, body) {
    return fetch(String(CFG.SUPABASE_URL).replace(/\/+$/, "") + "/rest/v1/rpc/" + fn, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: CFG.SUPABASE_ANON_KEY, Authorization: "Bearer " + CFG.SUPABASE_ANON_KEY },
      body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) throw new Error("Servidor do ranking respondeu " + r.status);
      return r.json();
    });
  }

  /* ---------------- entrar / criar conta ---------------- */
  /** Entra com o nome e a senha; se o nome ainda não existe, cria a conta. Resolve {nick, criado}. */
  function entrar(nick, pin) {
    var erro = validarNick(nick);
    if (erro) return Promise.reject(new Error(erro));
    if (String(pin || "").length < 4) return Promise.reject(new Error("A senha precisa ter pelo menos 4 caracteres."));
    nick = String(nick).trim();
    return hash(nick, pin).then(function (h) {
      function ok(criado) {
        lset(K_SESSAO, JSON.stringify({ nick: nick, hash: h }));
        return { nick: nick, criado: criado };
      }
      if (ONLINE) {
        return rpc("entrar", { p_nick: nick, p_hash: h }).then(function (res) {
          if (res === "criado") return ok(true);
          if (res === "ok") return ok(false);
          if (res === "senha_incorreta") throw new Error("Senha incorreta para este nome.");
          throw new Error("Nome ou senha inválidos.");
        });
      }
      var users = lparse(K_USERS, {});
      var k = nickKey(nick);
      if (!users[k]) {
        users[k] = { nick: nick, hash: h };
        if (!lset(K_USERS, JSON.stringify(users))) throw new Error("Não foi possível salvar a conta neste navegador.");
        return ok(true);
      }
      if (users[k].hash !== h) throw new Error("Senha incorreta para este nome.");
      nick = users[k].nick;
      return ok(false);
    });
  }

  /* ---------------- resultados ---------------- */
  /** Salva um resultado ({cidade, dificuldade, total}) para o jogador logado. */
  function salvar(r) {
    var s = sessao();
    if (!s) return Promise.reject(new Error("Entre para salvar o resultado."));
    var total = Math.max(0, Math.min(25000, Math.round(r.total)));
    if (ONLINE) {
      return rpc("salvar_resultado", { p_nick: s.nick, p_hash: s.hash, p_cidade: r.cidade, p_dificuldade: r.dificuldade, p_total: total })
        .then(function (res) { if (res !== "ok") throw new Error("O servidor recusou o resultado (" + res + ")."); });
    }
    var all = lparse(K_SCORES, []);
    all.push({ nick: s.nick, cidade: r.cidade, dificuldade: r.dificuldade, total: total, ts: Date.now() });
    if (all.length > MAX_LOCAL) all = all.slice(all.length - MAX_LOCAL);
    if (!lset(K_SCORES, JSON.stringify(all))) return Promise.reject(new Error("Não foi possível salvar neste navegador."));
    return Promise.resolve();
  }

  /** Melhor resultado de cada jogador no modo/local, do maior para o menor. Resolve [{nick,total,ts}]. */
  function ranking(cidade, dificuldade, limite) {
    limite = limite || 20;
    if (ONLINE) {
      return rpc("ranking", { p_cidade: cidade, p_dificuldade: dificuldade, p_limite: limite }).then(function (rows) {
        return (rows || []).map(function (x) { return { nick: String(x.nick), total: Number(x.total) || 0, ts: Date.parse(x.criado) || 0 }; });
      });
    }
    var best = {};
    lparse(K_SCORES, []).forEach(function (x) {
      if (x.cidade !== cidade || x.dificuldade !== dificuldade) return;
      var k = nickKey(x.nick);
      if (!best[k] || x.total > best[k].total) best[k] = x;
    });
    var list = Object.keys(best).map(function (k) { return best[k]; });
    list.sort(function (a, b) { return b.total - a.total || a.ts - b.ts; });
    return Promise.resolve(list.slice(0, limite));
  }

  window.Perfil = {
    online: ONLINE, current: current, entrar: entrar, sair: sair, salvar: salvar, ranking: ranking,
    validarNick: validarNick, nickKey: nickKey
  };
  if (typeof module !== "undefined" && module.exports) module.exports = window.Perfil;
})();
