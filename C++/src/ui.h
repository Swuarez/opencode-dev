#pragma once
// ui.h - Dear ImGui screens. Only reads App state and calls its actions.
#include "app.h"

namespace oi {

// Applies the black + accent style (accent depends on OCUI_THEME).
void uiApplyTheme(const std::string& theme);

// Draws one frame. ImGui::NewFrame must already have been called.
void uiDraw(App& app);

// Provided by the Win32 host (main.cpp). Used by the custom title bar.
void hostMinimize();
void hostMaximize();
void hostClose();

} // namespace oi
