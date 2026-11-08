# IP Player — Extensão para Chrome

[Español](../README.md) · [English](README.en.md) · [Català](README.ca.md) · [Euskara](README.eu.md) · [Français](README.fr.md) · [Português](README.pt.md)

---

Reprodutor de listas de reprodução M3U com suporte completo para **DASH**, **HLS** e **Smooth Streaming (ISM/ISML)**, além de DRM **ClearKey**, **Widevine** e servidores de licença personalizados. Utiliza o [Shaka Player](https://github.com/shaka-project/shaka-player) 4.16, [dash.js](https://github.com/Dash-Industry-Forum/dash.js) 5.3 para MSS ao vivo e [hls.js](https://github.com/video-dev/hls.js) 1.5 para HLS FairPlay/SAMPLE-AES com chave conhecida, todos empacotados em `lib/` sem dependências externas.

## Instalação

1. Abra `chrome://extensions` e ative o **Modo de desenvolvedor**.
2. Clique em **Carregar sem compactação** e selecione a pasta deste projeto.
3. Clique no ícone da extensão na barra de ferramentas para abrir o reprodutor.

## Uso

- **Listas** (ícone ☰): Adicione uma lista por URL, arquivo local ou colando o texto diretamente. As listas são salvas no armazenamento da extensão e podem ser atualizadas a qualquer momento.
- **Abrir stream** (ícone 🔗): Reproduza uma URL individual configurando tipo, DRM e cabeçalhos manuais. Também aceita entradas completas de canais M3U com propriedades `#KODIPROP`.
- **Editar** (ícone lápis): Abre o canal atual no formulário para ajustar chaves, servidor de licenças ou cabeçalhos.
- **Controles nativos do reprodutor**, consistentes no Shaka e dash.js: Seleção de qualidade (exibe o selo com a resolução atual ou ⚙ → Qualidade), faixas de áudio, legendas, velocidade de reprodução, barra de progresso DVR para transmissões ao vivo, indicador «AO VIVO», volume, Picture-in-Picture (PiP) e tela cheia.
- **Listas personalizadas** (☰ → *Criar lista própria*): Crie listas manualmente e organize-as em categorias (criar, renomear, excluir, mover e arrastar para reordenar canais). Para salvar canais nas suas listas, use o botão de pasta na barra inferior ou a opção «Salvar na lista» no formulário. Qualquer lista pode ser **baixada em M3U** (incluindo `#KODIPROP`, `#EXTVLCOPT` e `#EXTHTTP`, pronta para Kodi, TiviMate ou VLC) ou **em JSON** para reimportação editável.
- **Ajuda integrada**: Guia rápido no primeiro acesso (e acessível pelo botão ?), dicas com atalhos de teclado em todos os botões, mensagens de erro claras com opções «Tentar novamente» e «Revisar stream», e modo de texto ampliado para acessibilidade.
- **Idiomas e legendas**: Se a transmissão contiver várias faixas, ⚙ → *Áudio* e ⚙ → *Legendas* listam os idiomas e detalhes (5.1 surround, audiodescrição, CC, forçadas). O botão **CC** liga e desliga as legendas. O idioma escolhido é lembrado para os próximos canais. Suporta WebVTT, TTML e CEA-608 em DASH, HLS e Smooth Streaming.
- **Layout adaptativo**: Reprodutor no topo visível apenas quando houver reprodução ativa (com botão para fechar), mini player flutuante ao rolar a página e blocos organizados por categoria (linhas e grade com chips de categoria, favoritos e vistos recentemente).
- **Ação única «Adicionar»**: Botão centralizado para adicionar canal (com seleção de lista e categoria no próprio formulário), categoria, lista M3U (link, arquivo ou texto) ou lista personalizada.
- **Edição em tempo real**: Renomeie listas e categorias clicando diretamente nos títulos, reordene categorias, arraste canais entre categorias e acesse o menu de opções ⋯ de cada canal (editar, mover, salvar em outra lista, excluir).
- **Idiomas da interface**: Espanhol, inglês, catalão, basco, francês e português (Portugal e Brasil através de submenu). Cada idioma é um arquivo `locales/<código>.json` no formato `{ "texto em espanhol": "tradução" }`.
- **Proxy para streams (HTTP, HTTPS, SOCKS4 e SOCKS5)**: Permet carregar transmissões e manifestos através de um proxy. Configure um proxy geral em ? (Ajuda) → *Opções* (com botão para testar conexão) ou defina um proxy exclusivo por canal em *Opções avançadas* → *Proxy*. Suporta autenticação básica de usuário e senha em HTTP/HTTPS. Quando um canal utiliza proxy, o selo **Proxy** é exibido nos metadados de reprodução.
- **Guia de TV (EPG) integrado**: Suporte completo para guias de programação XMLTV em texto (`.xml`) ou compactado em gzip (`.xml.gz`, descompressão nativa no navegador com `DecompressionStream`). Se uma lista M3U incluir `#EXTM3U url-tvg="..."` ou `x-tvg-url="..."`, o guia é baixado e associado aos canais automaticamente.
  - **Em reprodução**: mostra o programa em exibição com barra de progresso em tempo real, horários e prévia do próximo programa.
  - **Grade interativa do Guia de TV** (botão «Guia de TV» ou atalho `G`): visualização dedicada em linha do tempo de 24 horas com abas de datas, categorias, busca, linha vermelha «Agora», modal de detalhes e reprodução imediata.
  - **Persistência no IndexedDB**: armazena os dados do guia localmente para carregamento instantâneo a cada abertura.

### Atalhos de teclado

| Tecla | Ação |
|---|---|
| `Espaço` / `K` | Reproduzir / Pausar |
| `←` / `→` | Retroceder / Avançar 10 s |
| `↑` / `↓` | Aumentar / Diminuir volume |
| `M` | Silenciar / Ativar áudio |
| `C` | Ativar / Desativar legendas |
| `F` | Tela cheia (ou clique duplo) |
| `PageUp` / `PageDown` | Canal anterior / seguinte |
| `/` | Buscar canal |
| `G` | Guia de TV (EPG) |
| `N` | Adicionar um canal |
| `?` | Ajuda e lista de atalhos |

- **Menu de contexto**: Clique com o botão direito em qualquer link da web → «Reproduzir no IP Player» ou «Carregar como lista M3U».

## Tags M3U suportadas

| Tag | Atributos / Sintaxe |
|---|---|
| `#EXTM3U` | `url-tvg="https://…/guia.xml.gz"`, `x-tvg-url="…"` |
|---|---|
| `#EXTINF` | `tvg-id`, `tvg-name`, `tvg-logo`, `group-title`, `tvg-chno`, `user-agent`, `http-referrer` |
| `#EXTGRP` | `#EXTGRP:Esportes` |
| `#KODIPROP` | `inputstream.adaptive.license_type`, `license_key`, `drm_legacy`, `drm` (JSON), `manifest_type`, `stream_headers`, `license_headers` |
| `#EXTVLCOPT` | `http-user-agent`, `http-referrer`, `http-origin`, `http-cookie`, `http-proxy`, `socks-proxy` |
| `#EXTHTTP` | `#EXTHTTP:{"User-Agent":"…","Cookie":"…"}` |
| URL com `\|` | `https://…/index.mpd\|User-Agent=X&Referer=Y` |

### Formatos de DRM

```m3u
# ClearKey com chaves locais (hex, UUID ou base64; múltiplas separadas por vírgula)
#KODIPROP:inputstream.adaptive.license_type=clearkey
#KODIPROP:inputstream.adaptive.license_key=KID:KEY

# ClearKey em formato JSON / JWK
#KODIPROP:inputstream.adaptive.license_key={"keys":[{"kty":"oct","kid":"…","k":"…"}]}

# Widevine com servidor de licenças: URL|cabeçalhos|modelo de corpo|modelo de resposta
#KODIPROP:inputstream.adaptive.license_type=com.widevine.alpha
#KODIPROP:inputstream.adaptive.license_key=https://lic/wv|Authorization=Bearer%20x|b{SSM}|JBlicense

# Formato antigo do Kodi
#KODIPROP:inputstream.adaptive.drm_legacy=org.w3.clearkey|KID:KEY

# HLS FairPlay (SAMPLE-AES em TS) com chave conhecida: KID:KEY, apenas KEY ou *:KEY:IV
#KODIPROP:inputstream.adaptive.license_type=com.apple.fps
#KODIPROP:inputstream.adaptive.license_key=*:KEY:IV

# HLS FairPlay com proxy de chaves (requisição GET; aceita {uri}, {id} = texto após skd://, e {kid})
#KODIPROP:inputstream.adaptive.license_key=https://meu-proxy/chave?id={id}
```

Modelos: corpo `R{SSM}` (binário), `b{SSM}` (base64) ou `B{SSM}` (base64 URL-encoded); resposta vazia (binário), `B` (base64) ou `J<campo>` / `JB<campo>` (campo JSON em base64).

### Proxy em listas M3U

```m3u
# Proxy por canal (SOCKS5, SOCKS4, HTTP ou HTTPS; aceita usuário:senha em HTTP/HTTPS)
#EXTVLCOPT:http-proxy=socks5://127.0.0.1:1080
#EXTINF:-1 group-title="Canais com proxy",Canal via SOCKS5
https://exemplo.pt/stream.m3u8
```

## Notas técnicas

- Cabeçalhos personalizados (`User-Agent`, `Referer`, `Origin`, `Cookie`) são aplicados via `declarativeNetRequest`, restritos exclusivamente às requisições da própria extensão.
- **Proxy dinâmico com PAC (`chrome.proxy`)**: É configurado através de um script PAC gerado dinamicamente (`FindProxyForURL`). Apenas os domínios de mídia do canal em reprodução (manifesto, segmentos de vídeo e servidores de licença) são roteados pelo proxy; a navegação comum do usuário permanece direta. Ao interromper a reprodução ou fechar a aba, o proxy é liberado automaticamente.
- **Smooth Streaming ao vivo**: O Shaka Player suporta nativamente apenas MSS sob demanda (VOD). Ao identificar uma transmissão MSS ao vivo (erro 4047), o reprodutor alterna automaticamente para o motor **dash.js**. Esse motor suporta conteúdos sem DRM ou com ClearKey.
- **HLS FairPlay / SAMPLE-AES em TS**: Navegadores Chromium não possuem CDM nativo para FairPlay. Se o canal fornecer chaves ClearKey ou um proxy de chaves, o IP Player utiliza o **hls.js** (`lib/hls.min.js`, 1.5.20), substitui as chaves `skd://` e descriptografa os segmentos TS localmente. Se o IV não estiver no manifesto, informe `*:KEY:IV`.
- **PlayReady**: Funciona exclusivamente no Microsoft Edge (o Chrome não possui o CDM PlayReady). No Chrome, utilize Widevine ou ClearKey.
- Fluxos MPEG-TS diretos (`.ts` isolados sem manifesto) não são suportados; transmissões HLS contendo segmentos TS são totalmente suportadas.
- O arquivo `sample/ejemplos.m3u` contém transmissões públicas de teste para cada formato (botão «Lista de exemplo»).

## Licença

Este projeto está sob a licença [Creative Commons Atribuição-NãoComercial-CompartilhaIgual 4.0 Internacional (CC BY-NC-SA 4.0)](../LICENSE).
- **Atribuição obrigatória (BY)**: É obrigatório dar os créditos a **Francesc Xavier Rosselló Encinas**.
- **Não comercial (NC)**: É estritamente proibida a venda, exploração comercial ou monetização deste software e de seus derivados.
- **Compartilha Igual (SA)**: Modificações são permitidas desde que qualquer trabalho derivado seja distribuído exatamente sob esta mesma licença estrita.
