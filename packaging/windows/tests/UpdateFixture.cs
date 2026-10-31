// Version-resource fixture; never launched by the tests.
using System.Reflection;
#if LEGACY_NAME
[assembly: AssemblyProduct("ふろじゅん")]
[assembly: AssemblyTitle("ふろじゅん Windows x64 インストーラー")]
#else
[assembly: AssemblyProduct("ふろきゅ～")]
[assembly: AssemblyTitle("ふろきゅ～ Windows x64 インストーラー")]
#endif
[assembly: AssemblyFileVersion("99.1.0")]
class UpdateFixture {static void Main(){}}
