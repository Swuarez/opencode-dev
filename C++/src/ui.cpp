// ui.cpp - minimal black + blue interface. Cubical layout, custom-drawn widgets.
#include "ui.h"

#include "lang.h"
#include "util.h"
#include "opencode.h"
#include "log.h"

#include <imgui.h>

#include <algorithm>
#include <cstdio>
#include <map>
#include <string>
#include <vector>

namespace oi {

// --------------------------------------------------------------- palette

static ImVec4 g_accent   = ImVec4(0.231f, 0.510f, 0.965f, 1.00f);
static ImVec4 g_accentHi = ImVec4(0.376f, 0.616f, 0.996f, 1.00f);
static ImVec4 g_accentLo = ImVec4(0.161f, 0.373f, 0.745f, 1.00f);

// Layered near-black surfaces. One saturated accent, nothing else.
static ImU32 kSurf2 = IM_COL32(23, 26, 33, 255);   // frames, ghost button
static ImU32 kSurf3 = IM_COL32(31, 35, 44, 255);   // hover
static ImU32 kLine  = IM_COL32(32, 37, 48, 255);   // hairline
static ImU32 kLine2 = IM_COL32(44, 50, 64, 255);
static ImU32 kText  = IM_COL32(230, 234, 242, 255);
static ImU32 kDim   = IM_COL32(110, 120, 138, 255);
static ImU32 kInk   = IM_COL32(6, 9, 15, 255);     // text on accent

static ImVec4 mul(const ImVec4& c, float f) { return ImVec4(c.x * f, c.y * f, c.z * f, c.w); }

static ImVec4 accentFor(const std::string& theme) {
    if (theme == "ocean")  return ImVec4(0.13f, 0.72f, 0.86f, 1.0f);
    if (theme == "forest") return ImVec4(0.30f, 0.78f, 0.42f, 1.0f);
    if (theme == "sunset") return ImVec4(1.00f, 0.54f, 0.20f, 1.0f);
    if (theme == "mono")   return ImVec4(0.72f, 0.76f, 0.82f, 1.0f);
    return ImVec4(0.231f, 0.510f, 0.965f, 1.0f);   // black -> blue
}

void uiApplyTheme(const std::string& theme) {
    ImGuiStyle& s = ImGui::GetStyle();
    ImGui::StyleColorsDark();

    g_accent   = accentFor(theme);
    g_accentHi = mul(g_accent, 1.28f);
    g_accentLo = mul(g_accent, 0.70f);

    ImVec4 bg   = ImVec4(0.039f, 0.043f, 0.055f, 1.00f);
    ImVec4 bg2  = ImVec4(0.067f, 0.075f, 0.094f, 1.00f);
    ImVec4 bg3  = ImVec4(0.090f, 0.102f, 0.129f, 1.00f);
    ImVec4 line = ImVec4(0.125f, 0.145f, 0.188f, 1.00f);

    ImVec4* c = s.Colors;
    c[ImGuiCol_Text]                  = ImVec4(0.902f, 0.918f, 0.949f, 1.00f);
    c[ImGuiCol_TextDisabled]          = ImVec4(0.431f, 0.471f, 0.541f, 1.00f);
    c[ImGuiCol_WindowBg]              = bg;
    c[ImGuiCol_ChildBg]               = bg2;
    c[ImGuiCol_PopupBg]               = ImVec4(0.067f, 0.075f, 0.094f, 0.99f);
    c[ImGuiCol_Border]                = line;
    c[ImGuiCol_BorderShadow]          = ImVec4(0, 0, 0, 0);
    c[ImGuiCol_FrameBg]               = bg3;
    c[ImGuiCol_FrameBgHovered]        = ImVec4(0.125f, 0.141f, 0.176f, 1.0f);
    c[ImGuiCol_FrameBgActive]         = mul(g_accent, 0.34f);
    c[ImGuiCol_TitleBg]               = bg;
    c[ImGuiCol_TitleBgActive]         = bg;
    c[ImGuiCol_TitleBgCollapsed]      = bg;
    c[ImGuiCol_MenuBarBg]             = bg2;
    c[ImGuiCol_ScrollbarBg]           = ImVec4(0, 0, 0, 0);
    c[ImGuiCol_ScrollbarGrab]         = ImVec4(0.180f, 0.200f, 0.243f, 1.0f);
    c[ImGuiCol_ScrollbarGrabHovered]  = ImVec4(0.243f, 0.267f, 0.318f, 1.0f);
    c[ImGuiCol_ScrollbarGrabActive]   = g_accent;
    c[ImGuiCol_CheckMark]             = g_accent;
    c[ImGuiCol_SliderGrab]            = g_accent;
    c[ImGuiCol_SliderGrabActive]      = g_accentHi;
    c[ImGuiCol_Button]                = bg3;
    c[ImGuiCol_ButtonHovered]         = ImVec4(0.137f, 0.157f, 0.196f, 1.0f);
    c[ImGuiCol_ButtonActive]          = mul(g_accent, 0.45f);
    c[ImGuiCol_Header]                = mul(g_accent, 0.22f);
    c[ImGuiCol_HeaderHovered]         = mul(g_accent, 0.36f);
    c[ImGuiCol_HeaderActive]          = mul(g_accent, 0.50f);
    c[ImGuiCol_Separator]             = line;
    c[ImGuiCol_SeparatorHovered]      = mul(g_accent, 0.70f);
    c[ImGuiCol_SeparatorActive]       = g_accent;
    c[ImGuiCol_ResizeGrip]            = ImVec4(0, 0, 0, 0);
    c[ImGuiCol_ResizeGripHovered]     = ImVec4(0, 0, 0, 0);
    c[ImGuiCol_ResizeGripActive]      = ImVec4(0, 0, 0, 0);
    c[ImGuiCol_Tab]                   = bg2;
    c[ImGuiCol_TabHovered]            = mul(g_accent, 0.55f);
    c[ImGuiCol_TabSelected]           = mul(g_accent, 0.75f);
    c[ImGuiCol_TabDimmed]             = bg2;
    c[ImGuiCol_TabDimmedSelected]     = mul(g_accent, 0.45f);
    c[ImGuiCol_TableHeaderBg]         = bg3;
    c[ImGuiCol_TableBorderStrong]     = line;
    c[ImGuiCol_TableBorderLight]      = mul(line, 0.75f);
    c[ImGuiCol_TableRowBg]            = ImVec4(0, 0, 0, 0);
    c[ImGuiCol_TableRowBgAlt]         = ImVec4(1, 1, 1, 0.018f);
    c[ImGuiCol_TextSelectedBg]        = mul(g_accent, 0.45f);
    c[ImGuiCol_NavHighlight]          = g_accent;
    c[ImGuiCol_ModalWindowDimBg]      = ImVec4(0.02f, 0.02f, 0.03f, 0.70f);

    // Cubical: near-zero rounding everywhere.
    s.WindowRounding    = 0.0f;
    s.ChildRounding     = 3.0f;
    s.FrameRounding     = 2.0f;
    s.PopupRounding     = 4.0f;
    s.GrabRounding      = 2.0f;
    s.TabRounding       = 2.0f;
    s.ScrollbarRounding = 4.0f;

    s.WindowBorderSize  = 0.0f;
    s.ChildBorderSize   = 1.0f;
    s.FrameBorderSize   = 1.0f;
    s.PopupBorderSize   = 1.0f;

    s.WindowPadding      = ImVec2(18, 16);
    s.FramePadding       = ImVec2(10, 6);
    s.ItemSpacing        = ImVec2(10, 8);
    s.ItemInnerSpacing   = ImVec2(6, 5);
    s.CellPadding        = ImVec2(6, 6);
    s.IndentSpacing      = 18.0f;
    s.ScrollbarSize      = 11.0f;
    s.GrabMinSize        = 11.0f;
}

// --------------------------------------------------------------- helpers

// tx() returns a copy; the pool keeps the const char* valid for the rest of the statement (ImGui labels).
static const char* T(const char* key) {
    static std::string pool[64];
    static int idx = 0;
    std::string& slot = pool[idx];
    idx = (idx + 1) % 64;
    slot.assign(tx(std::string(key)));
    return slot.c_str();
}

static std::string estModeName(App& app);

// ------------------------------------------------------------- widgets

enum class BtnKind { Primary, Ghost, Danger, Quiet };

// Flat, custom-drawn button. Rectangular, no gradient, no stock ImGui frame.
// Pass size.x <= 0 to size the button to its label.
static bool UiButton(const char* label, const ImVec2& size, BtnKind kind) {
    ImGui::PushID(label);

    float tw = ImGui::CalcTextSize(label).x;
    ImVec2 sz = size;
    if (sz.x <= 0.0f) sz.x = tw + 34.0f;
    if (sz.y <= 0.0f) sz.y = ImGui::GetFrameHeight();

    ImVec2 pos = ImGui::GetCursorScreenPos();
    bool pressed = ImGui::InvisibleButton("##b", sz);
    bool hovered = ImGui::IsItemHovered();
    bool held    = ImGui::IsItemActive();

    ImDrawList* dl = ImGui::GetWindowDrawList();
    ImVec2 a = pos;
    ImVec2 b = ImVec2(pos.x + sz.x, pos.y + sz.y);

    ImU32 fill, edge, txt;
    switch (kind) {
        case BtnKind::Primary:
            fill = held ? IM_COL32(58, 118, 220, 255) : (hovered ? ImGui::GetColorU32(g_accentHi) : ImGui::GetColorU32(g_accent));
            edge = 0;
            txt  = kInk;
            break;
        case BtnKind::Danger:
            fill = held ? IM_COL32(160, 44, 44, 255) : (hovered ? IM_COL32(186, 56, 56, 255) : IM_COL32(70, 30, 34, 255));
            edge = hovered ? 0 : IM_COL32(102, 42, 46, 255);
            txt  = hovered || held ? IM_COL32(255, 240, 240, 255) : IM_COL32(226, 150, 150, 255);
            break;
        case BtnKind::Quiet:
            fill = hovered ? IM_COL32(28, 32, 40, 255) : 0;
            edge = 0;
            txt  = hovered ? kText : kDim;
            break;
        default: // Ghost
            fill = held ? kSurf3 : (hovered ? kSurf3 : kSurf2);
            edge = hovered ? kLine2 : kLine;
            txt  = hovered ? kText : IM_COL32(198, 206, 220, 255);
            break;
    }

    if (fill) dl->AddRectFilled(a, b, fill, 3.0f);
    if (edge) dl->AddRect(a, b, edge, 3.0f);
    dl->AddText(ImVec2(pos.x + (sz.x - tw) * 0.5f, pos.y + (sz.y - ImGui::GetTextLineHeight()) * 0.5f), txt, label);

    ImGui::PopID();
    return pressed;
}

static bool PrimaryButton(const char* label, ImVec2 size = ImVec2(0, 0)) {
    return UiButton(label, size, BtnKind::Primary);
}
static bool GhostButton(const char* label, ImVec2 size = ImVec2(0, 0)) {
    return UiButton(label, size, BtnKind::Ghost);
}
static bool DangerButton(const char* label, ImVec2 size = ImVec2(0, 0)) {
    return UiButton(label, size, BtnKind::Danger);
}

// Dim accent tick + label. Used as an in-page section title.
static void SectionHeader(const char* text) {
    ImDrawList* dl = ImGui::GetWindowDrawList();
    ImVec2 p = ImGui::GetCursorScreenPos();
    float h = ImGui::GetTextLineHeight();
    dl->AddRectFilled(ImVec2(p.x, p.y + 1), ImVec2(p.x + 3, p.y + h - 1), ImGui::GetColorU32(g_accent), 1.0f);
    dl->AddText(ImVec2(p.x + 13, p.y), kDim, text);
    ImGui::Dummy(ImVec2(0, h));
}

static void Muted(const char* s) {
    ImGui::PushStyleColor(ImGuiCol_Text, ImGui::GetStyle().Colors[ImGuiCol_TextDisabled]);
    ImGui::TextWrapped("%s", s);
    ImGui::PopStyleColor();
}

static void KeyValue(const char* k, const std::string& v, bool accentValue = false) {
    ImGui::PushStyleColor(ImGuiCol_Text, ImGui::GetStyle().Colors[ImGuiCol_TextDisabled]);
    ImGui::TextUnformatted(k);
    ImGui::PopStyleColor();
    ImGui::SameLine(132.0f);
    if (accentValue) ImGui::PushStyleColor(ImGuiCol_Text, g_accentHi);
    ImGui::TextWrapped("%s", v.c_str());
    if (accentValue) ImGui::PopStyleColor();
}

static void Badge(const char* text, const ImVec4& col) {
    ImVec2 p = ImGui::GetCursorScreenPos();
    ImVec2 sz = ImGui::CalcTextSize(text);
    ImDrawList* dl = ImGui::GetWindowDrawList();
    ImGui::Dummy(ImVec2(sz.x + 18, sz.y + 10));
    dl->AddRectFilled(p, ImVec2(p.x + sz.x + 18, p.y + sz.y + 10), ImGui::GetColorU32(mul(col, 0.22f)), 3.0f);
    dl->AddRect(p, ImVec2(p.x + sz.x + 18, p.y + sz.y + 10), ImGui::GetColorU32(mul(col, 0.85f)), 3.0f);
    dl->AddText(ImVec2(p.x + 9, p.y + 5), ImGui::GetColorU32(col), text);
}

// ------------------------------------------------------------- title bar
// Frameless chrome. Keep the sizes in sync with main.cpp (kTitleBarHeight,
// kTitleButtonsWidth).

static const float kTitleBarH    = 38.0f;
static const float kTitleButtonW = 44.0f;

static bool titleBarButton(const char* id, const ImVec2& pos, const ImVec2& size, bool isClose, bool isMax = false) {
    ImGui::SetCursorScreenPos(pos);
    bool pressed = ImGui::InvisibleButton(id, size);
    bool hovered = ImGui::IsItemHovered();
    ImDrawList* dl = ImGui::GetWindowDrawList();

    if (hovered) {
        ImU32 fill = isClose ? IM_COL32(214, 64, 64, 255) : IM_COL32(255, 255, 255, 16);
        dl->AddRectFilled(pos, ImVec2(pos.x + size.x, pos.y + size.y), fill);
    }
    ImU32 col = (isClose && hovered) ? IM_COL32(255, 255, 255, 255) : IM_COL32(190, 198, 212, 255);

    if (isClose) {
        const float m = 0.36f;
        ImVec2 a(pos.x + size.x * m, pos.y + size.y * m);
        ImVec2 b(pos.x + size.x * (1.0f - m), pos.y + size.y * (1.0f - m));
        dl->AddLine(a, b, col, 1.5f);
        dl->AddLine(ImVec2(b.x, a.y), ImVec2(a.x, b.y), col, 1.5f);
    } else if (isMax) {
        ImVec2 a(pos.x + size.x * 0.36f, pos.y + size.y * 0.33f);
        ImVec2 b(pos.x + size.x * 0.64f, pos.y + size.y * 0.67f);
        dl->AddRect(a, b, col, 0.0f, 0, 1.3f);
    } else {
        float cy = pos.y + size.y * 0.5f;
        dl->AddLine(ImVec2(pos.x + size.x * 0.32f, cy), ImVec2(pos.x + size.x * 0.68f, cy), col, 1.5f);
    }
    return pressed;
}

// Draws the full-bleed title strip and leaves the cursor just below it.
static void drawTitleBar() {
    ImVec2 wp = ImGui::GetWindowPos();
    float  w  = ImGui::GetWindowWidth();
    ImDrawList* dl = ImGui::GetWindowDrawList();

    // The window draw list is clipped to the content rect; widen it for the strip.
    dl->PushClipRect(wp, ImVec2(wp.x + w, wp.y + kTitleBarH), false);
    dl->AddRectFilled(wp, ImVec2(wp.x + w, wp.y + kTitleBarH), IM_COL32(13, 15, 19, 255));
    dl->AddLine(ImVec2(wp.x, wp.y + kTitleBarH - 0.5f), ImVec2(wp.x + w, wp.y + kTitleBarH - 0.5f),
                kLine, 1.0f);

    float cy = wp.y + kTitleBarH * 0.5f;
    dl->AddRectFilled(ImVec2(wp.x + 20, cy - 6), ImVec2(wp.x + 32, cy + 6), ImGui::GetColorU32(g_accent), 2.0f);
    dl->AddText(ImVec2(wp.x + 44, cy - ImGui::GetFontSize() * 0.5f), IM_COL32(226, 231, 240, 255),
                "OpenCode Infinite");

    float bx = wp.x + w - kTitleButtonW * 3.0f;
    if (titleBarButton("##title_min", ImVec2(bx, wp.y), ImVec2(kTitleButtonW, kTitleBarH), false))
        hostMinimize();
    if (titleBarButton("##title_max", ImVec2(bx + kTitleButtonW, wp.y), ImVec2(kTitleButtonW, kTitleBarH), false, true))
        hostMaximize();
    if (titleBarButton("##title_close", ImVec2(bx + kTitleButtonW * 2.0f, wp.y), ImVec2(kTitleButtonW, kTitleBarH), true))
        hostClose();
    dl->PopClipRect();

    ImGui::SetCursorScreenPos(ImVec2(wp.x + ImGui::GetStyle().WindowPadding.x, wp.y + kTitleBarH + 14.0f));
}

// ----------------------------------------------------------- settings rows

static std::string g_group;   // settings section picked in the sidebar
static std::string g_textEditKey;
static std::string g_textEditVal;
static bool        g_textEditRequest = false;

static const char* enumDisplay(const std::string& key, const std::string& code) {
    if (key == "OCUI_LANG") {
        if (code == "auto") return T("Automatic");
        if (code == "en") return "English";
        if (code == "es") return "Espanol";
        if (code == "fr") return "Francais";
        if (code == "de") return "Deutsch";
        if (code == "pt") return "Portugues";
        if (code == "it") return "Italiano";
        if (code == "tr") return "Turkce";
    }
    return code.c_str();
}

static void drawSetting(App& app, const SettingDef& d) {
    Config& cfg = app.cfg();
    ImGui::PushID(d.key.c_str());

    switch (d.kind) {
        case SettingKind::BoolK: {
            bool v = cfg.b(d.key);
            if (ImGui::Checkbox(T(d.label.c_str()), &v)) {
                cfg.set(d.key, v ? "1" : "0");
                app.saveCfg();
            }
            break;
        }
        case SettingKind::NumK: {
            int v = cfg.i(d.key);
            ImGui::SetNextItemWidth(160);
            bool changed = false;
            if (d.maxv > d.minv) {
                changed = ImGui::SliderInt(T(d.label.c_str()), &v, d.minv, d.maxv);
            } else {
                changed = ImGui::InputInt(T(d.label.c_str()), &v);
            }
            if (changed) {
                if (d.maxv > d.minv) v = std::min(std::max(v, d.minv), d.maxv);
                cfg.set(d.key, fmt("%d", v));
                app.saveCfg();
            }
            break;
        }
        case SettingKind::TextK: {
            std::string val = cfg.s(d.key);
            std::string shown = val.empty() ? std::string("(empty)") : val;
            if (shown.size() > 52) shown = shown.substr(0, 49) + "...";
            ImGui::AlignTextToFramePadding();
            ImGui::TextUnformatted(T(d.label.c_str()));
            ImGui::SameLine(320.0f);
            ImGui::PushStyleColor(ImGuiCol_Text, ImGui::GetStyle().Colors[ImGuiCol_TextDisabled]);
            ImGui::TextUnformatted(shown.c_str());
            ImGui::PopStyleColor();
            ImGui::SameLine();
            if (UiButton(T("Edit"), ImVec2(56, 22), BtnKind::Ghost)) {
                g_textEditKey = d.key;
                g_textEditVal = val;
                g_textEditRequest = true;
            }
            break;
        }
        case SettingKind::EnumK: {
            int cur = 0;
            std::string v = cfg.s(d.key);
            for (size_t i = 0; i < d.choices.size(); ++i)
                if (iequals(d.choices[i], v)) { cur = (int)i; break; }
            ImGui::SetNextItemWidth(220);
            if (ImGui::BeginCombo(T(d.label.c_str()), enumDisplay(d.key, d.choices[cur]))) {
                for (size_t i = 0; i < d.choices.size(); ++i) {
                    bool sel = ((int)i == cur);
                    if (ImGui::Selectable(enumDisplay(d.key, d.choices[i]), sel)) {
                        cfg.set(d.key, d.choices[i]);
                        app.saveCfg();
                        if (d.key == "OCUI_LANG") app.swapLangRefresh();
                    }
                    if (sel) ImGui::SetItemDefaultFocus();
                }
                ImGui::EndCombo();
            }
            break;
        }
    }

    if (!d.desc.empty()) {
        ImGui::PushStyleColor(ImGuiCol_Text, ImGui::GetStyle().Colors[ImGuiCol_TextDisabled]);
        ImGui::TextWrapped("%s", T(d.desc.c_str()));
        ImGui::PopStyleColor();
    }
    ImGui::Spacing();
    ImGui::PopID();
}

// ------------------------------------------------------------------ sidebar

static const float kSideW = 210.0f;

static bool sideItem(const char* label, bool selected, float indent) {
    ImGui::PushID(label);
    ImVec2 pos = ImGui::GetCursorScreenPos();
    ImVec2 sz(ImGui::GetContentRegionAvail().x, 32.0f);
    bool pressed = ImGui::InvisibleButton("##s", sz);
    bool hov = ImGui::IsItemHovered();
    ImDrawList* dl = ImGui::GetWindowDrawList();
    ImVec2 b(pos.x + sz.x, pos.y + sz.y);
    if (selected) {
        dl->AddRectFilled(pos, b, ImGui::GetColorU32(mul(g_accent, 0.22f)), 3.0f);
        dl->AddRectFilled(pos, ImVec2(pos.x + 3, b.y), ImGui::GetColorU32(g_accent), 1.0f);
    } else if (hov) {
        dl->AddRectFilled(pos, b, kSurf3, 3.0f);
    }
    dl->AddText(ImVec2(pos.x + 14 + indent, pos.y + (sz.y - ImGui::GetTextLineHeight()) * 0.5f),
                selected ? kText : (hov ? kText : IM_COL32(170, 180, 198, 255)), label);
    ImGui::PopID();
    return pressed;
}

static void drawSidebar(App& app) {
    Screen cur = app.screen();
    if (sideItem(T("Home"), cur == Screen::Home || cur == Screen::ModePicker || cur == Screen::Menu, 0))
        app.setScreen(Screen::Home);
    if (sideItem(T("Settings"), cur == Screen::Settings, 0)) app.setScreen(Screen::Settings);
    if (cur == Screen::Settings) {
        for (const auto& g : Config::groups())
            if (sideItem(T(g.c_str()), g == g_group, 14.0f)) g_group = g;
    }
    if (sideItem(T("Chats"), cur == Screen::Chats, 0)) { app.refreshArchives(); app.setScreen(Screen::Chats); }
    if (sideItem(T("Renew session"), cur == Screen::Renew, 0)) app.setScreen(Screen::Renew);
    if (sideItem(T("Support"), cur == Screen::Support, 0)) app.setScreen(Screen::Support);
    if (sideItem(T("Uninstall"), cur == Screen::Uninstall, 0)) app.setScreen(Screen::Uninstall);
    ImGui::Spacing();
    ImGui::Separator();
    ImGui::Spacing();
    if (sideItem(T("Exit"), false, 0)) app.requestQuit();
}

// ------------------------------------------------------------------ screens

static void drawLogPanel(App& app) {
    ImGui::BeginChild("##logs", ImVec2(0, 118), true, ImGuiWindowFlags_HorizontalScrollbar);
    ImU32 cols[4] = {
        IM_COL32(176, 184, 198, 255),
        ImGui::GetColorU32(g_accentHi),
        IM_COL32(230, 188, 96, 255),
        IM_COL32(232, 100, 100, 255),
    };
    std::vector<LogLine> lines = app.logLines();
    for (const auto& l : lines) {
        int k = (l.kind < 0 || l.kind > 3) ? 0 : l.kind;
        ImGui::PushStyleColor(ImGuiCol_Text, ImGui::GetStyle().Colors[ImGuiCol_TextDisabled]);
        ImGui::TextUnformatted(l.time.c_str());
        ImGui::PopStyleColor();
        ImGui::SameLine(92.0f);
        ImGui::PushStyleColor(ImGuiCol_Text, ImGui::ColorConvertU32ToFloat4(cols[k]));
        ImGui::TextWrapped("%s", l.text.c_str());
        ImGui::PopStyleColor();
    }
    if (!lines.empty()) ImGui::SetScrollHereY(1.0f);
    ImGui::EndChild();
}

static void drawHeader(App& app) {
    // Left: version tag.
    ImGui::PushStyleColor(ImGuiCol_Text, ImGui::GetStyle().Colors[ImGuiCol_TextDisabled]);
    ImGui::Text("v%s", kLauncherVersion);
    ImGui::PopStyleColor();

    // Right: state pill.
    std::string mode = estModeName(app);
    if (mode.empty()) mode = "-";
    std::string ip = app.egress().lastIp.empty() ? std::string("-") : app.egress().lastIp;
    if (!app.egress().lastLoc.empty()) ip += "  (" + app.egress().lastLoc + ")";
    std::string right = mode + "   \xc2\xb7   " + ip;

    float x = ImGui::GetWindowWidth() - ImGui::CalcTextSize(right.c_str()).x - 18.0f;
    if (x < ImGui::GetCursorPosX() + 24.0f) x = ImGui::GetCursorPosX() + 24.0f;
    ImGui::SameLine(x);
    ImGui::PushStyleColor(ImGuiCol_Text, g_accentHi);
    ImGui::TextUnformatted(mode.c_str());
    ImGui::PopStyleColor();
    ImGui::SameLine();
    ImGui::PushStyleColor(ImGuiCol_Text, ImGui::GetStyle().Colors[ImGuiCol_TextDisabled]);
    ImGui::TextUnformatted("\xc2\xb7");
    ImGui::PopStyleColor();
    ImGui::SameLine();
    ImGui::TextUnformatted(ip.c_str());

    if (app.busy()) {
        ImGui::SameLine();
        ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.90f, 0.74f, 0.38f, 1.0f));
        ImGui::TextUnformatted(T("working..."));
        ImGui::PopStyleColor();
    }
    ImGui::Separator();
    ImGui::Spacing();
}

static std::string estModeName(App& app) {
    switch (app.egress().mode) {
        case Egress::Warp:  return "WARP";
        case Egress::Tor:   return "TOR";
        case Egress::Proxy: return "PROXY";
        case Egress::Wireproxy: return "WIREGUARD";
        case Egress::VpnGate:   return "VPNGATE";
        case Egress::None:  return "NONE";
    }
    return "";
}

static void drawHome(App& app) {
    const EgressState& e = app.egress();

    // Status card.
    ImGui::BeginChild("##homeStatus", ImVec2(0, 104), true);
    ImGui::Spacing();
    KeyValue(T("Exit IP"), e.lastIp.empty() ? std::string("-")
                                            : e.lastIp + (e.lastLoc.empty() ? "" : "  (" + e.lastLoc + ")"),
             !e.lastIp.empty());
    KeyValue(T("Route"), estModeName(app).empty() ? std::string("-") : estModeName(app));
    KeyValue(T("OpenCode"), app.appExe().empty() ? std::string(T("not found"))
                                                 : (app.appRunning() ? std::string(T("running"))
                                                                     : std::string(T("closed"))));
    ImGui::EndChild();

    ImGui::Spacing();

    // The one action that matters: new exit IP, then start OpenCode with it.
    if (PrimaryButton(T("New IP and start OpenCode"), ImVec2(0, 38))) app.newIpAndStart();
    ImGui::SameLine();
    if (GhostButton(T("Connect with opencode"), ImVec2(0, 38))) app.connectWith();
    if (app.configured()) {
        ImGui::SameLine();
        Badge(T("Configured"), g_accent);
    }

}

static void drawModePicker(App& app) {
    SectionHeader(T("Connection method"));
    ImGui::Spacing();
    Muted(T("Pick the exit route for this start. The choice is not saved."));
    ImGui::Spacing();
    ImGui::Separator();
    ImGui::Spacing();

    struct M { const char* code; const char* label; const char* desc; };
    static const M modes[] = {
        {"WARP",  "WARP",  "Cloudflare WARP in local proxy mode. Every rotation registers again, which gives a new exit IP."},
        {"TOR",   "Tor",   "Tor with an HTTP bridge on 127.0.0.1. A Tor already running is reused and never closed."},
        {"PROXY", "PROXY", "Free HTTP proxies from the list. Dead ones are skipped."},
        {"WIREGUARD", "WireGuard", "Your WireGuard .conf files through wireproxy, a local proxy that only opencode uses. No administrator prompt."},
        {"VPNGATE",   "VPN Gate",  "VPN Gate servers through OpenVPN. Only OpenCode's hosts go through the tunnel. Administrator prompt on start, switch and stop."},
        {"NONE",  "NONE",  "Direct connection, no proxy."},
    };
    for (const M& m : modes) {
        ImGui::PushID(m.code);
        if (PrimaryButton(T(m.label), ImVec2(120, 30))) app.pickMode(m.code);
        ImGui::SameLine();
        ImGui::PushStyleColor(ImGuiCol_Text, ImGui::GetStyle().Colors[ImGuiCol_TextDisabled]);
        ImGui::TextWrapped("%s", T(m.desc));
        ImGui::PopStyleColor();
        ImGui::Spacing();
        ImGui::PopID();
    }
    ImGui::Spacing();
    ImGui::Separator();
    ImGui::Spacing();
    if (GhostButton(T("Back"), ImVec2(110, 30))) app.setScreen(Screen::Home);
}

static void drawMenu(App& app) {
    ImGui::BeginChild("##menuInfo", ImVec2(0, 104), true);
    ImGui::Spacing();
    KeyValue(T("App"), app.appExe().empty() ? std::string(T("not found")) : app.appExe());
    KeyValue(T("Connection"), estModeName(app).empty() ? std::string("-") : estModeName(app));
    KeyValue(T("Exit IP"), app.egress().lastIp.empty() ? std::string("-") : app.egress().lastIp + " " + app.egress().lastLoc);
    KeyValue(T("OpenCode"), app.appRunning() ? T("running") : T("closed"));
    ImGui::EndChild();
    ImGui::Spacing();

    float w = 0.0f;
    if (GhostButton(T("1  New IP and start OpenCode"), ImVec2(w, 32))) app.newIpAndStart();
    if (GhostButton(T("2  Clear tokens, then start"), ImVec2(w, 32))) app.clearTokensAndStart();
    if (GhostButton(T("3  Change IP (test)"), ImVec2(w, 32))) app.changeIpTest();
    if (GhostButton(T("4  Deep reset or restore chats"), ImVec2(w, 32))) { app.refreshArchives(); app.setScreen(Screen::Chats); }
    if (GhostButton(T("5  Settings"), ImVec2(w, 32))) app.setScreen(Screen::Settings);
    if (GhostButton(T("6  Back"), ImVec2(w, 32))) app.setScreen(Screen::Home);
    if (GhostButton(T("7  Exit"), ImVec2(w, 32))) app.requestQuit();
}

static void drawSettings(App& app) {
    SectionHeader(T("Settings"));
    ImGui::SameLine(ImGui::GetWindowWidth() - 220.0f);
    if (GhostButton(T("Back"), ImVec2(90, 26))) app.setScreen(Screen::Home);
    ImGui::SameLine();
    if (GhostButton(T("Reset all"), ImVec2(110, 26))) {
        app.cfg().resetAll();
        app.saveCfg();
        app.swapLangRefresh();
        app.rescanDesktop();   // OC_APP may have changed
    }
    ImGui::Spacing();
    ImGui::Separator();
    ImGui::Spacing();

    ImGui::BeginChild("##cfgscroll", ImVec2(0, 0));
    std::vector<std::string> groups = Config::groups();
    if (g_group.empty() || std::find(groups.begin(), groups.end(), g_group) == groups.end())
        g_group = groups.empty() ? std::string() : groups[0];
    for (const auto& g : groups) {
        if (g == g_group) {
            SectionHeader(T(g.c_str()));
            ImGui::Spacing();
            ImGui::Spacing();
            ImGui::Indent(14.0f);
            for (const auto& d : Config::defs()) {
                if (d.group != g) continue;
                drawSetting(app, d);
            }
            if (g == "Paths") {
                // OC_APP is edited above (validated on save); these drop the 10 min detection cache
                KeyValue(T("Desktop app"), app.appExe().empty() ? std::string(T("not found")) : app.appExe());
                if (GhostButton(T("Detect again"), ImVec2(140, 28))) app.rescanDesktop();
                ImGui::SameLine();
                if (GhostButton(T("Clear cache"), ImVec2(140, 28))) app.clearCacheNow();
                ImGui::Spacing();
            }
            ImGui::Unindent(14.0f);
            ImGui::Spacing();
        }
    }
    ImGui::EndChild();
}

static void drawChats(App& app) {
    SectionHeader(T("Deep reset or restore chats"));
    ImGui::SameLine(ImGui::GetWindowWidth() - 110.0f);
    if (GhostButton(T("Back"), ImVec2(90, 26))) app.setScreen(Screen::Home);
    ImGui::Spacing();
    ImGui::Separator();
    ImGui::Spacing();

    ImGui::BeginChild("##chatsL", ImVec2(ImGui::GetWindowWidth() * 0.52f, 0), false);
    Muted(T("Deep reset stops OpenCode, moves the database and the storage folder to the Desktop, clears tokens and the cache, then starts a fresh session. Nothing is deleted."));
    ImGui::Spacing();
    if (PrimaryButton(T("Deep reset"), ImVec2(180, 32))) app.deepResetNow();
    ImGui::Spacing();
    ImGui::Separator();
    ImGui::Spacing();
    Muted(T("Restore chats lists the archived folders, newest first. The chats in place now are moved aside before an archive is copied back."));
    ImGui::EndChild();

    ImGui::SameLine();
    ImGui::BeginChild("##chatsR", ImVec2(0, 0), true);
    ImGui::TextUnformatted(T("Archived chats"));
    ImGui::Spacing();
    static int sel = -1;
    const std::vector<std::string>& arch = app.archives();
    if (arch.empty()) {
        Muted(T("No archives yet."));
    } else {
        for (int i = 0; i < (int)arch.size(); ++i) {
            std::string name = fileName(arch[i]);
            if (ImGui::Selectable(name.c_str(), sel == i)) sel = i;
        }
    }
    ImGui::Spacing();
    ImGui::BeginDisabled(sel < 0 || sel >= (int)arch.size());
    if (PrimaryButton(T("Restore selected"), ImVec2(160, 28))) {
        std::string dir = arch[sel];
        app.restoreArchive(dir);
    }
    ImGui::EndDisabled();
    ImGui::SameLine();
    if (GhostButton(T("Refresh"), ImVec2(100, 28))) app.refreshArchives();
    ImGui::EndChild();
}

static void drawRenew(App& app) {
    SectionHeader(T("Renew session"));
    ImGui::Spacing();
    ImGui::Separator();
    ImGui::Spacing();
    Muted(T("Use this when the free limit is reached or the login has expired. It closes OpenCode, copies the login file to the launcher backup folder, clears the saved tokens, and gets a new IP."));
    ImGui::Spacing();
    if (PrimaryButton(T("Renew session"), ImVec2(180, 32))) app.renewSession();
    ImGui::SameLine();
    if (GhostButton(T("Back"), ImVec2(100, 32))) app.setScreen(Screen::Home);
}

static void drawUninstall(App& app) {
    SectionHeader(T("Uninstall"));
    ImGui::Spacing();
    ImGui::Separator();
    ImGui::Spacing();
    Muted(T("Removes only what setup added and restores the settings it changed. The launcher file and your chats are not touched."));
    ImGui::Spacing();
    if (DangerButton(T("Uninstall"), ImVec2(180, 32))) app.doUninstall();
    ImGui::SameLine();
    if (GhostButton(T("Back"), ImVec2(100, 32))) app.setScreen(Screen::Home);
}

static void drawSupport(App& app) {
    SectionHeader(T("Support"));
    ImGui::SameLine(ImGui::GetWindowWidth() - 110.0f);
    if (GhostButton(T("Back"), ImVec2(90, 26))) app.setScreen(Screen::Home);
    ImGui::Spacing();
    ImGui::Separator();
    ImGui::Spacing();

    ImGui::BeginChild("##suppL", ImVec2(ImGui::GetWindowWidth() * 0.52f, 0), false);
    Muted(T("Writes one text file with versions, settings and the recent log, for help. Passwords and tokens are removed. IPs are masked by default."));
    ImGui::Spacing();
    if (PrimaryButton(T("Write support report"), ImVec2(180, 30))) app.writeSupport();
    ImGui::Spacing();
    if (GhostButton(T("Check for updates"), ImVec2(180, 28))) app.checkUpdates(true);
    ImGui::Spacing();
    if (GhostButton(T("Open state folder"), ImVec2(180, 28))) app.openFolder(stateDir());
    if (GhostButton(T("Open log"), ImVec2(180, 28))) app.openFolder(logPath());
    ImGui::EndChild();

    ImGui::SameLine();
    ImGui::BeginChild("##suppR", ImVec2(0, 0), true);
    KeyValue(T("Launcher"), std::string(kLauncherVersion));
    KeyValue(T("State folder"), stateDir());
    KeyValue(T("Log file"), logPath());
    KeyValue(T("OpenCode data"), opencodeDataDir());
    KeyValue(T("Desktop app"), app.appExe().empty() ? std::string(T("not found")) : app.appExe());
    KeyValue(T("Probe CLI"), app.probeCli().empty() ? std::string(T("not found")) : app.probeCli());
    ImGui::EndChild();
}

// ------------------------------------------------------------------- frame

static void drawTextEditPopup(App& app) {
    static char buf[2048];
    static bool initBuf = false;
    if (g_textEditRequest) {
        ImGui::OpenPopup("##textedit");
        g_textEditRequest = false;
        initBuf = true;
    }
    ImGui::SetNextWindowSize(ImVec2(560, 0));
    if (ImGui::BeginPopupModal("##textedit", nullptr, ImGuiWindowFlags_AlwaysAutoResize)) {
        const SettingDef* d = Config::findDef(g_textEditKey);
        if (d) {
            if (initBuf) {
                snprintf(buf, sizeof(buf), "%s", g_textEditVal.c_str());
                initBuf = false;
            }
            ImGui::TextUnformatted(T(d->label.c_str()));
            ImGui::Spacing();
            ImGui::SetNextItemWidth(520);
            bool entered = ImGui::InputText("##val", buf, sizeof(buf), ImGuiInputTextFlags_EnterReturnsTrue);
            ImGui::Spacing();
            if (PrimaryButton(T("Save"), ImVec2(110, 30)) || entered) {
                if (g_textEditKey == "OC_APP") {
                    // checked and logged by the app; a missing file keeps the popup open
                    if (app.setDesktopPath(buf)) ImGui::CloseCurrentPopup();
                } else {
                    app.cfg().set(g_textEditKey, buf);
                    app.saveCfg();
                    ImGui::CloseCurrentPopup();
                }
            }
            ImGui::SameLine();
            if (GhostButton(T("Cancel"), ImVec2(110, 30))) ImGui::CloseCurrentPopup();
        } else {
            ImGui::CloseCurrentPopup();
        }
        ImGui::EndPopup();
    }
}

static void drawClosePrompt(App& app) {
    if (!app.closePrompt()) return;
    ImGui::OpenPopup("OpenCode closed");
    if (ImGui::BeginPopupModal("OpenCode closed", nullptr, ImGuiWindowFlags_AlwaysAutoResize)) {
        ImGui::TextUnformatted(T("OpenCode closed."));
        ImGui::Spacing();
        ImGui::PushStyleColor(ImGuiCol_Text, ImGui::GetStyle().Colors[ImGuiCol_TextDisabled]);
        ImGui::Text("%s", tx("Press {0} to get a new IP and start again, {1} for the menu, {2} to quit.",
                              std::vector<std::string>{app.cfg().s("KEY_ROTATE"), app.cfg().s("KEY_MENU"),
                                                       app.cfg().s("KEY_QUIT")}).c_str());
        ImGui::PopStyleColor();
        ImGui::Spacing();
        ImGui::Separator();
        ImGui::Spacing();
        if (PrimaryButton(tx("{0}  New IP and start", app.cfg().s("KEY_ROTATE")).c_str(), ImVec2(180, 32)))
            app.resolveClosePrompt(app.cfg().s("KEY_ROTATE").empty() ? 'R' : app.cfg().s("KEY_ROTATE")[0]);
        ImGui::SameLine();
        if (GhostButton(tx("{0}  Menu", app.cfg().s("KEY_MENU")).c_str(), ImVec2(120, 32)))
            app.resolveClosePrompt(app.cfg().s("KEY_MENU").empty() ? 'M' : app.cfg().s("KEY_MENU")[0]);
        ImGui::SameLine();
        if (GhostButton(tx("{0}  Quit", app.cfg().s("KEY_QUIT")).c_str(), ImVec2(120, 32)))
            app.resolveClosePrompt(app.cfg().s("KEY_QUIT").empty() ? 'Q' : app.cfg().s("KEY_QUIT")[0]);
        ImGui::EndPopup();
    }
}

void uiDraw(App& app) {
    uiApplyTheme(app.cfg().s("OCUI_THEME"));

    ImGuiViewport* vp = ImGui::GetMainViewport();
    ImGui::SetNextWindowPos(vp->WorkPos);
    ImGui::SetNextWindowSize(vp->WorkSize);
    ImGuiWindowFlags flags = ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoResize |
                             ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoCollapse |
                             ImGuiWindowFlags_NoBringToFrontOnFocus | ImGuiWindowFlags_NoNavFocus |
                             ImGuiWindowFlags_NoScrollbar;
    ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(18, 16));
    ImGui::Begin("##root", nullptr, flags);
    ImGui::PopStyleVar();

    drawTitleBar();
    drawHeader(app);

    float logH = 118.0f + ImGui::GetStyle().ItemSpacing.y * 2;
    ImGui::BeginChild("##side", ImVec2(kSideW, -logH), false);
    drawSidebar(app);
    ImGui::EndChild();
    ImGui::SameLine();
    ImGui::BeginChild("##body", ImVec2(0, -logH), false);
    switch (app.screen()) {
        case Screen::Home:       drawHome(app);       break;
        case Screen::ModePicker: drawModePicker(app);  break;
        case Screen::Menu:       drawMenu(app);        break;
        case Screen::Settings:   drawSettings(app);    break;
        case Screen::Chats:      drawChats(app);       break;
        case Screen::Renew:      drawRenew(app);       break;
        case Screen::Uninstall:  drawUninstall(app);   break;
        case Screen::Support:    drawSupport(app);     break;
    }
    ImGui::EndChild();

    drawLogPanel(app);

    drawTextEditPopup(app);
    drawClosePrompt(app);

    ImGui::End();
}

} // namespace oi
