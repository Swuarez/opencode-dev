#pragma once
// support.h - one text report with versions, settings and the recent log.
#include <string>

#include "config.h"

namespace oi {

// Writes the report and returns its path ("" on failure).
std::string writeSupportReport(const Config& cfg);

} // namespace oi
