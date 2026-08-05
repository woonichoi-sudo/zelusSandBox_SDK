// stb_image 구현 제공 (헤드리스 전용)
//
// tinygltf의 LoadImageData가 stbi_load_from_memory 등을 쓴다. 저장소의
// scene/zwGltfExporter.cpp는 TINYGLTF_IMPLEMENTATION과
// STB_IMAGE_WRITE_IMPLEMENTATION만 정의하고 STB_IMAGE_IMPLEMENTATION은
// 정의하지 않는데, 데스크톱 빌드에서는 nanovg가 그 심볼들을 제공한다.
//
// 헤드리스는 nanovg(2D 렌더러 의존성)를 링크하지 않으므로 여기서 직접
// 구현을 만들어 준다. 저장소 파일은 건드리지 않는다.

#define STB_IMAGE_IMPLEMENTATION
#include <stb_image.h>
