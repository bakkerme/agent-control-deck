/**
 * acd-ui-sim — host-side pixel UI for Agent Control Deck.
 *
 * Compiles firmware ui_layout + status_parse against a software EPD shim and
 * presents the 960×540 4-bit framebuffer in an SDL2 window (or BMP export).
 */

#include <SDL.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

#include <unistd.h>

#include "epd_driver.h"
#include "status_model.h"
#include "status_parse.h"
#include "ui_layout.h"

namespace {

constexpr size_t kFbBytes = static_cast<size_t>(EPD_WIDTH) * static_cast<size_t>(EPD_HEIGHT) / 2;

struct Options {
    std::string input_path;
    std::string from_url;
    std::string bmp_path;
    uint32_t age_ms = 12000;
    bool stale = false;
    bool no_link = false; /* stale + empty rows */
    bool force_schema = false;
    int schema_override = -1; /* if >= 0, rewrite schema_version in raw JSON */
    bool empty = false;
    DeckLinkState link = DECK_LINK_OK;
    std::string transport = "ble";
    int scale = 1;
    double poll_s = 0.0;
    bool once = false; /* draw once and exit (for --bmp) */
};

void usage(const char *argv0)
{
    std::fprintf(stderr,
                 "Usage: %s [options] [snapshot.json]\n"
                 "\n"
                 "Pixel-accurate PC preview of the deck e-paper UI (design C · 8 rows).\n"
                 "Uses the same ui_layout.cpp + FiraSansUI as firmware.\n"
                 "\n"
                 "Options:\n"
                 "  --from-url URL     GET StatusSnapshot JSON (requires curl in PATH)\n"
                 "  --poll SEC         Reload source every SEC seconds (default: 0 = once)\n"
                 "  --bmp PATH         Write framebuffer as BMP and exit (no window if set alone)\n"
                 "  --age-ms N         Link age for top bar / STALE copy (default 12000)\n"
                 "  --stale            Mark snapshot stale (banner if rows remain)\n"
                 "  --no-link          STALE + empty cache (NO LINK frame)\n"
                 "  --empty            Force zero rows (empty body frames)\n"
                 "  --schema           SCHEMA fault frame (last_schema_version=2)\n"
                 "  --schema-version N Rewrite JSON schema_version before parse (N!=1 → SCHEMA)\n"
                 "  --degraded         Link degraded token (!)\n"
                 "  --down             Link down token (o)\n"
                 "  --transport NAME   Transport label (default ble → BLE)\n"
                 "  --scale N          Integer window scale 1–3 (default 1)\n"
                 "  --once             Exit after first present (window still opens unless --bmp)\n"
                 "  -h, --help         This help\n"
                 "\n"
                 "Keys (window): q quit · r reload · s stale · n no-link · e schema · 0 healthy\n"
                 "\n"
                 "Example:\n"
                 "  %s ../../schema/examples/design_c_sessions.json\n"
                 "  %s --stale --age-ms 45000 ../../schema/examples/mock_3sessions.json\n"
                 "  %s --from-url http://127.0.0.1:8787/v1/status --poll 2\n",
                 argv0, argv0, argv0, argv0);
}

bool parse_args(int argc, char **argv, Options *opt)
{
    for (int i = 1; i < argc; i++) {
        const char *a = argv[i];
        auto need = [&](const char *name) -> const char * {
            if (i + 1 >= argc) {
                std::fprintf(stderr, "error: %s needs a value\n", name);
                return nullptr;
            }
            return argv[++i];
        };
        if (std::strcmp(a, "-h") == 0 || std::strcmp(a, "--help") == 0) {
            usage(argv[0]);
            std::exit(0);
        } else if (std::strcmp(a, "--from-url") == 0) {
            const char *v = need("--from-url");
            if (!v) {
                return false;
            }
            opt->from_url = v;
        } else if (std::strcmp(a, "--poll") == 0) {
            const char *v = need("--poll");
            if (!v) {
                return false;
            }
            opt->poll_s = std::atof(v);
        } else if (std::strcmp(a, "--bmp") == 0) {
            const char *v = need("--bmp");
            if (!v) {
                return false;
            }
            opt->bmp_path = v;
            opt->once = true;
        } else if (std::strcmp(a, "--age-ms") == 0) {
            const char *v = need("--age-ms");
            if (!v) {
                return false;
            }
            opt->age_ms = static_cast<uint32_t>(std::strtoul(v, nullptr, 10));
        } else if (std::strcmp(a, "--stale") == 0) {
            opt->stale = true;
        } else if (std::strcmp(a, "--no-link") == 0) {
            opt->no_link = true;
            opt->stale = true;
        } else if (std::strcmp(a, "--empty") == 0) {
            opt->empty = true;
        } else if (std::strcmp(a, "--schema") == 0) {
            opt->force_schema = true;
        } else if (std::strcmp(a, "--schema-version") == 0) {
            const char *v = need("--schema-version");
            if (!v) {
                return false;
            }
            opt->schema_override = std::atoi(v);
        } else if (std::strcmp(a, "--degraded") == 0) {
            opt->link = DECK_LINK_DEGRADED;
        } else if (std::strcmp(a, "--down") == 0) {
            opt->link = DECK_LINK_DOWN;
        } else if (std::strcmp(a, "--transport") == 0) {
            const char *v = need("--transport");
            if (!v) {
                return false;
            }
            opt->transport = v;
        } else if (std::strcmp(a, "--scale") == 0) {
            const char *v = need("--scale");
            if (!v) {
                return false;
            }
            opt->scale = std::atoi(v);
            if (opt->scale < 1) {
                opt->scale = 1;
            }
            if (opt->scale > 3) {
                opt->scale = 3;
            }
        } else if (std::strcmp(a, "--once") == 0) {
            opt->once = true;
        } else if (a[0] == '-') {
            std::fprintf(stderr, "error: unknown option %s\n", a);
            return false;
        } else {
            if (!opt->input_path.empty()) {
                std::fprintf(stderr, "error: multiple input paths\n");
                return false;
            }
            opt->input_path = a;
        }
    }
    if (opt->input_path.empty() && opt->from_url.empty()) {
        std::fprintf(stderr, "error: provide snapshot.json or --from-url\n");
        return false;
    }
    return true;
}

bool read_file(const std::string &path, std::vector<uint8_t> *out)
{
    std::ifstream f(path, std::ios::binary);
    if (!f) {
        std::fprintf(stderr, "error: cannot open %s\n", path.c_str());
        return false;
    }
    f.seekg(0, std::ios::end);
    const auto n = f.tellg();
    if (n < 0) {
        return false;
    }
    f.seekg(0, std::ios::beg);
    out->resize(static_cast<size_t>(n));
    if (n > 0) {
        f.read(reinterpret_cast<char *>(out->data()), n);
    }
    return true;
}

bool fetch_url(const std::string &url, std::vector<uint8_t> *out)
{
    /* Shell out to curl so we avoid linking libcurl for the MVP. */
    char tmpl[] = "/tmp/acd-ui-sim-XXXXXX";
    int fd = mkstemp(tmpl);
    if (fd < 0) {
        std::perror("mkstemp");
        return false;
    }
    close(fd);

    std::string cmd = "curl -fsSL --max-time 10 -o ";
    cmd += tmpl;
    cmd += " ";
    cmd += "'";
    for (char c : url) {
        if (c == '\'') {
            cmd += "'\\''";
        } else {
            cmd += c;
        }
    }
    cmd += "'";
    const int rc = std::system(cmd.c_str());
    if (rc != 0) {
        std::fprintf(stderr, "error: curl failed for %s (exit %d)\n", url.c_str(), rc);
        std::remove(tmpl);
        return false;
    }
    const bool ok = read_file(tmpl, out);
    std::remove(tmpl);
    return ok;
}

void rewrite_schema_version(std::vector<uint8_t> *json, int version)
{
    /* Minimal rewrite: replace "schema_version": <int> first occurrence. */
    std::string s(json->begin(), json->end());
    const char *key = "\"schema_version\"";
    const auto pos = s.find(key);
    if (pos == std::string::npos) {
        return;
    }
    auto colon = s.find(':', pos + std::strlen(key));
    if (colon == std::string::npos) {
        return;
    }
    auto i = colon + 1;
    while (i < s.size() && (s[i] == ' ' || s[i] == '\t')) {
        i++;
    }
    auto j = i;
    if (j < s.size() && (s[j] == '-' || (s[j] >= '0' && s[j] <= '9'))) {
        if (s[j] == '-') {
            j++;
        }
        while (j < s.size() && s[j] >= '0' && s[j] <= '9') {
            j++;
        }
    }
    s.replace(i, j - i, std::to_string(version));
    json->assign(s.begin(), s.end());
}

void apply_device_state(DeckView *view, const Options &opt, StatusParseResult pr)
{
    view->age_ms = opt.age_ms;
    view->link_state = opt.link;
    view->stale = opt.stale || opt.no_link;
    view->fault = DECK_FAULT_NONE;
    std::snprintf(view->transport, sizeof(view->transport), "%s", opt.transport.c_str());

    if (opt.force_schema || pr == STATUS_PARSE_SCHEMA) {
        view->fault = DECK_FAULT_SCHEMA;
        if (view->last_schema_version == 1 || view->last_schema_version == 0) {
            view->last_schema_version = 2;
        }
    }

    if (opt.empty || opt.no_link) {
        view->row_count = 0;
    }
    if (opt.no_link) {
        view->stale = true;
        view->link_state = DECK_LINK_DOWN;
    }
}

bool load_snapshot(const Options &opt, DeckView *view, StatusParseResult *pr_out)
{
    std::vector<uint8_t> raw;
    if (!opt.from_url.empty()) {
        if (!fetch_url(opt.from_url, &raw)) {
            return false;
        }
    } else if (!read_file(opt.input_path, &raw)) {
        return false;
    }

    if (opt.schema_override >= 0) {
        rewrite_schema_version(&raw, opt.schema_override);
    }

    std::memset(view, 0, sizeof(*view));
    const StatusParseResult pr = status_parse_snapshot(raw.data(), raw.size(), view);
    *pr_out = pr;

    if (pr == STATUS_PARSE_ERROR) {
        std::fprintf(stderr, "error: status_parse failed (invalid JSON or missing fields)\n");
        return false;
    }
    /* SCHEMA is a valid sim frame — still draw. */
    apply_device_state(view, opt, pr);
    return true;
}

/** Expand 4-bit packed grayscale (0=black … 15=white nibble) to 32-bit RGBA. */
void fb_to_rgba(const uint8_t *fb, uint32_t *rgba)
{
    for (int y = 0; y < EPD_HEIGHT; y++) {
        for (int x = 0; x < EPD_WIDTH; x++) {
            const uint8_t byte = fb[y * EPD_WIDTH / 2 + x / 2];
            const uint8_t nibble = (x % 2) ? (byte >> 4) : (byte & 0x0F);
            /* color stored as high nibble of epd color; draw uses 0x00 black / 0xFF white.
               After >>4 or &0xF we get 0..15 where 0 is black, 15 is white (font path).
               epd_draw_pixel stores color&0xF0 into high or color>>4 into low — so ink 0
               and paper 0xFF → nibble 0 or 0xF. */
            const uint8_t g = static_cast<uint8_t>((nibble * 255) / 15);
            rgba[y * EPD_WIDTH + x] = (0xFFu << 24) | (g << 16) | (g << 8) | g;
        }
    }
}

bool write_bmp(const char *path, const uint32_t *rgba)
{
    SDL_Surface *surf = SDL_CreateRGBSurfaceWithFormatFrom(
        const_cast<uint32_t *>(rgba), EPD_WIDTH, EPD_HEIGHT, 32, EPD_WIDTH * 4,
        SDL_PIXELFORMAT_RGBA32);
    if (!surf) {
        std::fprintf(stderr, "error: SDL_CreateRGBSurface: %s\n", SDL_GetError());
        return false;
    }
    if (SDL_SaveBMP(surf, path) != 0) {
        std::fprintf(stderr, "error: SDL_SaveBMP: %s\n", SDL_GetError());
        SDL_FreeSurface(surf);
        return false;
    }
    SDL_FreeSurface(surf);
    std::printf("wrote %s\n", path);
    return true;
}

} // namespace

int main(int argc, char **argv)
{
    Options opt;
    if (!parse_args(argc, argv, &opt)) {
        usage(argv[0]);
        return 2;
    }

    if (SDL_Init(SDL_INIT_VIDEO) != 0) {
        std::fprintf(stderr, "error: SDL_Init: %s\n", SDL_GetError());
        return 1;
    }

    std::vector<uint8_t> fb(kFbBytes);
    std::vector<uint32_t> rgba(static_cast<size_t>(EPD_WIDTH) * EPD_HEIGHT);
    DeckView view{};
    StatusParseResult pr = STATUS_PARSE_OK;

    auto render = [&]() -> bool {
        if (!load_snapshot(opt, &view, &pr)) {
            return false;
        }
        ui_draw_status(fb.data(), &view);
        fb_to_rgba(fb.data(), rgba.data());
        return true;
    };

    if (!render()) {
        SDL_Quit();
        return 1;
    }

    if (!opt.bmp_path.empty()) {
        const bool ok = write_bmp(opt.bmp_path.c_str(), rgba.data());
        SDL_Quit();
        return ok ? 0 : 1;
    }

    const int win_w = EPD_WIDTH * opt.scale;
    const int win_h = EPD_HEIGHT * opt.scale;
    SDL_Window *win = SDL_CreateWindow(
        "Agent Control Deck — UI sim (design C)", SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED,
        win_w, win_h, SDL_WINDOW_SHOWN);
    if (!win) {
        std::fprintf(stderr, "error: SDL_CreateWindow: %s\n", SDL_GetError());
        SDL_Quit();
        return 1;
    }

    SDL_Renderer *ren = SDL_CreateRenderer(win, -1, SDL_RENDERER_ACCELERATED);
    if (!ren) {
        ren = SDL_CreateRenderer(win, -1, 0);
    }
    if (!ren) {
        std::fprintf(stderr, "error: SDL_CreateRenderer: %s\n", SDL_GetError());
        SDL_DestroyWindow(win);
        SDL_Quit();
        return 1;
    }
    SDL_SetHint(SDL_HINT_RENDER_SCALE_QUALITY, "0"); /* nearest-neighbor for crisp pixels */
    SDL_RenderSetLogicalSize(ren, EPD_WIDTH, EPD_HEIGHT);

    SDL_Texture *tex =
        SDL_CreateTexture(ren, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_STREAMING, EPD_WIDTH,
                          EPD_HEIGHT);
    if (!tex) {
        std::fprintf(stderr, "error: SDL_CreateTexture: %s\n", SDL_GetError());
        SDL_DestroyRenderer(ren);
        SDL_DestroyWindow(win);
        SDL_Quit();
        return 1;
    }

    auto present = [&]() {
        SDL_UpdateTexture(tex, nullptr, rgba.data(), EPD_WIDTH * 4);
        SDL_SetRenderDrawColor(ren, 180, 180, 180, 255);
        SDL_RenderClear(ren);
        SDL_RenderCopy(ren, tex, nullptr, nullptr);
        SDL_RenderPresent(ren);
    };
    present();

    if (opt.once) {
        SDL_Delay(100); /* let window paint once */
        SDL_DestroyTexture(tex);
        SDL_DestroyRenderer(ren);
        SDL_DestroyWindow(win);
        SDL_Quit();
        return 0;
    }

    bool running = true;
    uint32_t last_poll = SDL_GetTicks();
    while (running) {
        SDL_Event e;
        while (SDL_PollEvent(&e)) {
            if (e.type == SDL_QUIT) {
                running = false;
            } else if (e.type == SDL_KEYDOWN) {
                switch (e.key.keysym.sym) {
                case SDLK_q:
                case SDLK_ESCAPE:
                    running = false;
                    break;
                case SDLK_r:
                    render();
                    present();
                    break;
                case SDLK_s:
                    opt.stale = !opt.stale;
                    opt.no_link = false;
                    render();
                    present();
                    break;
                case SDLK_n:
                    opt.no_link = true;
                    opt.stale = true;
                    opt.force_schema = false;
                    render();
                    present();
                    break;
                case SDLK_e:
                    opt.force_schema = !opt.force_schema;
                    render();
                    present();
                    break;
                case SDLK_0:
                    opt.stale = false;
                    opt.no_link = false;
                    opt.force_schema = false;
                    opt.empty = false;
                    opt.link = DECK_LINK_OK;
                    render();
                    present();
                    break;
                default:
                    break;
                }
            }
        }

        if (opt.poll_s > 0.0) {
            const uint32_t now = SDL_GetTicks();
            if (now - last_poll >= static_cast<uint32_t>(opt.poll_s * 1000.0)) {
                last_poll = now;
                if (render()) {
                    present();
                }
            }
        }
        SDL_Delay(16);
    }

    SDL_DestroyTexture(tex);
    SDL_DestroyRenderer(ren);
    SDL_DestroyWindow(win);
    SDL_Quit();
    return 0;
}
