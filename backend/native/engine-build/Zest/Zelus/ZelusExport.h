
#ifndef ZELUS_API_H
#define ZELUS_API_H

#ifdef ZELUS_STATIC_DEFINE
#  define ZELUS_API
#  define ZELUS_NO_EXPORT
#else
#  ifndef ZELUS_API
#    ifdef Zelus_EXPORTS
        /* We are building this library */
#      define ZELUS_API __declspec(dllexport)
#    else
        /* We are using this library */
#      define ZELUS_API __declspec(dllimport)
#    endif
#  endif

#  ifndef ZELUS_NO_EXPORT
#    define ZELUS_NO_EXPORT 
#  endif
#endif

#ifndef ZELUS_DEPRECATED
#  define ZELUS_DEPRECATED __declspec(deprecated)
#endif

#ifndef ZELUS_DEPRECATED_EXPORT
#  define ZELUS_DEPRECATED_EXPORT ZELUS_API ZELUS_DEPRECATED
#endif

#ifndef ZELUS_DEPRECATED_NO_EXPORT
#  define ZELUS_DEPRECATED_NO_EXPORT ZELUS_NO_EXPORT ZELUS_DEPRECATED
#endif

/* NOLINTNEXTLINE(readability-avoid-unconditional-preprocessor-if) */
#if 0 /* DEFINE_NO_DEPRECATED */
#  ifndef ZELUS_NO_DEPRECATED
#    define ZELUS_NO_DEPRECATED
#  endif
#endif

#endif /* ZELUS_API_H */
