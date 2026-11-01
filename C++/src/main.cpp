// main.cpp - Win32 window + Direct3D 11 + Dear ImGui host for the launcher.
#include "app.h"
#include "ui.h"
#include "util.h"

#include <imgui.h>
#include <imgui_impl_win32.h>
#include <imgui_impl_dx11.h>

#include <d3d11.h>
#include <windowsx.h>
#include <tchar.h>

#include <string>

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "d3dcompiler.lib")

extern IMGUI_IMPL_API LRESULT ImGui_ImplWin32_WndProcHandler(HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam);

// Custom (frameless) title bar. Keep in sync with the drawing in ui.cpp.
static const int kTitleBarHeight = 38;
static const int kTitleButtonsWidth = 88;   // two 44 px buttons on the right

static HWND g_hwnd = nullptr;

namespace oi {
void hostMinimize() { if (g_hwnd) ::ShowWindow(g_hwnd, SW_MINIMIZE); }
void hostClose()    { if (g_hwnd) ::PostMessageW(g_hwnd, WM_CLOSE, 0, 0); }
} // namespace oi

static ID3D11Device*            g_pd3dDevice = nullptr;
static ID3D11DeviceContext*     g_pd3dDeviceContext = nullptr;
static IDXGISwapChain*          g_pSwapChain = nullptr;
static bool                     g_SwapChainOccluded = false;
static UINT                     g_ResizeWidth = 0, g_ResizeHeight = 0;
static ID3D11RenderTargetView*  g_mainRenderTargetView = nullptr;

static void CreateRenderTarget() {
    ID3D11Texture2D* pBackBuffer = nullptr;
    g_pSwapChain->GetBuffer(0, IID_PPV_ARGS(&pBackBuffer));
    if (pBackBuffer) {
        g_pd3dDevice->CreateRenderTargetView(pBackBuffer, nullptr, &g_mainRenderTargetView);
        pBackBuffer->Release();
    }
}

static void CleanupRenderTarget() {
    if (g_mainRenderTargetView) { g_mainRenderTargetView->Release(); g_mainRenderTargetView = nullptr; }
}

static bool CreateDeviceD3D(HWND hWnd) {
    DXGI_SWAP_CHAIN_DESC sd;
    ZeroMemory(&sd, sizeof(sd));
    sd.BufferCount = 2;
    sd.BufferDesc.Width = 0;
    sd.BufferDesc.Height = 0;
    sd.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    sd.BufferDesc.RefreshRate.Numerator = 60;
    sd.BufferDesc.RefreshRate.Denominator = 1;
    sd.Flags = DXGI_SWAP_CHAIN_FLAG_ALLOW_MODE_SWITCH;
    sd.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    sd.OutputWindow = hWnd;
    sd.SampleDesc.Count = 1;
    sd.SampleDesc.Quality = 0;
    sd.Windowed = TRUE;
    sd.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;

    UINT createDeviceFlags = 0;
    D3D_FEATURE_LEVEL featureLevel;
    const D3D_FEATURE_LEVEL featureLevelArray[2] = { D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_0 };
    HRESULT res = D3D11CreateDeviceAndSwapChain(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, createDeviceFlags,
                                                featureLevelArray, 2, D3D11_SDK_VERSION, &sd, &g_pSwapChain,
                                                &g_pd3dDevice, &featureLevel, &g_pd3dDeviceContext);
    if (res == DXGI_ERROR_UNSUPPORTED)
        res = D3D11CreateDeviceAndSwapChain(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, createDeviceFlags,
                                            featureLevelArray, 2, D3D11_SDK_VERSION, &sd, &g_pSwapChain,
                                            &g_pd3dDevice, &featureLevel, &g_pd3dDeviceContext);
    if (FAILED(res)) return false;

    CreateRenderTarget();
    return true;
}

static void CleanupDeviceD3D() {
    CleanupRenderTarget();
    if (g_pSwapChain)        { g_pSwapChain->Release();        g_pSwapChain = nullptr; }
    if (g_pd3dDeviceContext) { g_pd3dDeviceContext->Release(); g_pd3dDeviceContext = nullptr; }
    if (g_pd3dDevice)        { g_pd3dDevice->Release();        g_pd3dDevice = nullptr; }
}

static LRESULT WINAPI WndProc(HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    if (ImGui_ImplWin32_WndProcHandler(hWnd, msg, wParam, lParam))
        return true;

    switch (msg) {
        case WM_NCHITTEST: {
            // Frameless window: the title strip drags, everything else is client space.
            POINT pt = { GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam) };
            ::ScreenToClient(hWnd, &pt);
            RECT rc;
            ::GetClientRect(hWnd, &rc);
            bool inTitle   = (pt.y >= 0 && pt.y < kTitleBarHeight);
            bool inButtons = (pt.x >= rc.right - kTitleButtonsWidth && pt.x < rc.right);
            if (inTitle && !inButtons) return HTCAPTION;
            return HTCLIENT;
        }
        case WM_SIZE:
            if (wParam == SIZE_MINIMIZED) return 0;
            g_ResizeWidth = (UINT)LOWORD(lParam);
            g_ResizeHeight = (UINT)HIWORD(lParam);
            return 0;
        case WM_SYSCOMMAND:
            if ((wParam & 0xfff0) == SC_KEYMENU) return 0;
            break;
        case WM_DESTROY:
            PostQuitMessage(0);
            return 0;
    }
    return DefWindowProcW(hWnd, msg, wParam, lParam);
}

static void LoadUiFont(float size) {
    ImGuiIO& io = ImGui::GetIO();
    io.Fonts->Clear();

    static const ImWchar ranges[] = {
        0x0020, 0x00FF,   // Basic Latin + Latin-1 Supplement
        0x0100, 0x017F,   // Latin Extended-A (Turkish, etc.)
        0x0180, 0x024F,   // Latin Extended-B
        0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2026,
        0,
    };

    ImFontConfig fc;
    fc.OversampleH = 2;
    fc.OversampleV = 2;
    fc.PixelSnapH = true;

    const char* candidates[] = {
        "C:\\Windows\\Fonts\\segoeui.ttf",
        "C:\\Windows\\Fonts\\tahoma.ttf",
        "C:\\Windows\\Fonts\\arial.ttf",
    };
    bool done = false;
    for (const char* f : candidates) {
        if (GetFileAttributesA(f) == INVALID_FILE_ATTRIBUTES) continue;
        if (io.Fonts->AddFontFromFileTTF(f, size, &fc, ranges)) { done = true; break; }
    }
    if (!done) {
        ImFontConfig d;
        d.SizePixels = size;
        io.Fonts->AddFontDefault(&d);
    }
    io.Fonts->Build();
}

int APIENTRY wWinMain(HINSTANCE hInstance, HINSTANCE, LPWSTR, int) {
    // one launcher per session: two would fight over the same OpenCode and egress (released at exit)
    HANDLE single = ::CreateMutexW(nullptr, FALSE, L"Local\\OpenCodeInfiniteLauncher");
    if (single && ::GetLastError() == ERROR_ALREADY_EXISTS) {
        ::MessageBoxW(nullptr, L"OpenCode Infinite is already running.", L"OpenCode Infinite",
                      MB_ICONINFORMATION | MB_OK | MB_TOPMOST);
        ::CloseHandle(single);
        return 0;
    }

    oi::App app;
    app.init();

    WNDCLASSEXW wc = { sizeof(wc), CS_CLASSDC, WndProc, 0L, 0L, hInstance, nullptr, nullptr, nullptr, nullptr,
                       L"OpenCodeInfiniteWnd", nullptr };
    ::RegisterClassExW(&wc);

    // Frameless, fixed-size window. The chrome is drawn by ui.cpp.
    // Fit the window to the work area so it never overflows a small display.
    RECT wa = { 0, 0, 1280, 720 };
    ::SystemParametersInfoW(SPI_GETWORKAREA, 0, &wa, 0);
    int waW = wa.right - wa.left;
    int waH = wa.bottom - wa.top;
    int w = 980, h = 620;
    if (w > waW - 40) w = waW - 40;
    if (h > waH - 40) h = waH - 40;
    HWND hwnd = ::CreateWindowExW(WS_EX_APPWINDOW, wc.lpszClassName, L"OpenCode Infinite",
                                  WS_POPUP | WS_MINIMIZEBOX,
                                  wa.left + (waW - w) / 2, wa.top + (waH - h) / 2, w, h,
                                  nullptr, nullptr, wc.hInstance, nullptr);
    if (!hwnd) return 1;
    g_hwnd = hwnd;

    if (!CreateDeviceD3D(hwnd)) {
        CleanupDeviceD3D();
        ::UnregisterClassW(wc.lpszClassName, wc.hInstance);
        MessageBoxW(hwnd, L"Direct3D 11 could not be initialised.", L"OpenCode Infinite", MB_ICONERROR | MB_OK);
        return 1;
    }

    ::ShowWindow(hwnd, SW_SHOWNORMAL);
    // Pin the placement: a popup window still gets nudged by the shell.
    ::SetWindowPos(hwnd, nullptr, wa.left + (waW - w) / 2, wa.top + (waH - h) / 2, w, h,
                   SWP_NOZORDER | SWP_NOACTIVATE);
    ::UpdateWindow(hwnd);

    IMGUI_CHECKVERSION();
    ImGui::CreateContext();
    ImGuiIO& io = ImGui::GetIO();
    io.ConfigFlags |= ImGuiConfigFlags_NavEnableKeyboard;
    io.IniFilename = nullptr;

    int fontSize = app.cfg().i("OCUI_FONT_SIZE");
    if (fontSize < 11) fontSize = 16;
    LoadUiFont((float)fontSize);

    ImGui::StyleColorsDark();
    ImGui_ImplWin32_Init(hwnd);
    ImGui_ImplDX11_Init(g_pd3dDevice, g_pd3dDeviceContext);

    const ImVec4 clear = ImVec4(0.055f, 0.062f, 0.078f, 1.0f);

    bool done = false;
    while (!done) {
        MSG msg;
        while (::PeekMessage(&msg, nullptr, 0U, 0U, PM_REMOVE)) {
            ::TranslateMessage(&msg);
            ::DispatchMessage(&msg);
            if (msg.message == WM_QUIT) done = true;
        }
        if (done) break;

        if (app.shouldQuit()) break;

        if (g_SwapChainOccluded && g_pSwapChain->Present(0, DXGI_PRESENT_TEST) == DXGI_STATUS_OCCLUDED) {
            ::Sleep(10);
            continue;
        }
        g_SwapChainOccluded = false;

        if (g_ResizeWidth != 0 && g_ResizeHeight != 0) {
            CleanupRenderTarget();
            g_pSwapChain->ResizeBuffers(0, g_ResizeWidth, g_ResizeHeight, DXGI_FORMAT_UNKNOWN, 0);
            g_ResizeWidth = g_ResizeHeight = 0;
            CreateRenderTarget();
        }

        // Font size change -> rebuild atlas and device objects.
        int wantSize = app.cfg().i("OCUI_FONT_SIZE");
        if (wantSize < 11) wantSize = 16;
        if (wantSize != fontSize) {
            fontSize = wantSize;
            LoadUiFont((float)fontSize);
            ImGui_ImplDX11_InvalidateDeviceObjects();
            ImGui_ImplDX11_CreateDeviceObjects();
        }

        ImGui_ImplDX11_NewFrame();
        ImGui_ImplWin32_NewFrame();
        ImGui::NewFrame();

        app.tick();
        oi::uiDraw(app);

        ImGui::Render();
        const float c[4] = { clear.x, clear.y, clear.z, clear.w };
        g_pd3dDeviceContext->OMSetRenderTargets(1, &g_mainRenderTargetView, nullptr);
        g_pd3dDeviceContext->ClearRenderTargetView(g_mainRenderTargetView, c);
        ImGui_ImplDX11_RenderDrawData(ImGui::GetDrawData());

        HRESULT hr = g_pSwapChain->Present(1, 0);
        g_SwapChainOccluded = (hr == DXGI_STATUS_OCCLUDED);
    }

    ImGui_ImplDX11_Shutdown();
    ImGui_ImplWin32_Shutdown();
    ImGui::DestroyContext();
    app.shutdown();

    CleanupDeviceD3D();
    ::DestroyWindow(hwnd);
    ::UnregisterClassW(wc.lpszClassName, wc.hInstance);
    return 0;
}
