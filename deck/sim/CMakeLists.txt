cmake_minimum_required(VERSION 3.16)
project(acd_ui_sim LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 99)

# ---------------------------------------------------------------------------
# Dependencies: SDL2 (window / BMP), ArduinoJson (same as firmware parser)
# ---------------------------------------------------------------------------
find_package(SDL2 REQUIRED)

include(FetchContent)
FetchContent_Declare(
  ArduinoJson
  GIT_REPOSITORY https://github.com/bblanchon/ArduinoJson.git
  GIT_TAG        v7.4.2
  GIT_SHALLOW    TRUE
)
FetchContent_MakeAvailable(ArduinoJson)

set(DECK_SRC_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../src")

add_executable(acd-ui-sim
  main.cpp
  host_epd_draw.c
  host_font.c
  "${DECK_SRC_DIR}/ui_layout.cpp"
  "${DECK_SRC_DIR}/status_parse.cpp"
)

target_include_directories(acd-ui-sim PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/include"
  "${DECK_SRC_DIR}"
)

# Host epd_driver.h must win over any other path.
target_compile_definitions(acd-ui-sim PRIVATE ACD_HOST_SIM=1)

target_link_libraries(acd-ui-sim PRIVATE
  SDL2::SDL2
  ArduinoJson
)

if(APPLE)
  # Homebrew SDL2 sometimes needs explicit framework paths; find_package usually enough.
endif()

install(TARGETS acd-ui-sim RUNTIME DESTINATION bin)

message(STATUS "acd-ui-sim: SDL2 + ArduinoJson host build of deck UI")
