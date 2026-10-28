"""Check the manifest and runtime settings that Windows/.NET actually load."""
from pathlib import Path
import struct
import sys
import xml.etree.ElementTree as ET


def verify(executable):
    executable = Path(executable)
    data = executable.read_bytes()
    pe = struct.unpack_from('<I', data, 0x3c)[0]
    assert data[pe:pe + 4] == b'PE\0\0', 'Not a Windows PE executable'
    sections = struct.unpack_from('<H', data, pe + 6)[0]
    optional_size = struct.unpack_from('<H', data, pe + 20)[0]
    optional = pe + 24
    magic = struct.unpack_from('<H', data, optional)[0]
    assert magic in (0x10b, 0x20b)
    directories = optional + (112 if magic == 0x20b else 96)
    resource_rva = struct.unpack_from('<I', data, directories + 16)[0]

    def file_offset(rva):
        for index in range(sections):
            offset = optional + optional_size + index * 40
            virtual_size, address, raw_size, raw_offset = struct.unpack_from('<IIII', data, offset + 8)
            if address <= rva < address + max(virtual_size, raw_size):
                return raw_offset + rva - address
        raise AssertionError('Missing PE resource section')

    root = file_offset(resource_rva)

    def entries(relative):
        directory = root + relative
        named, numbered = struct.unpack_from('<HH', data, directory + 12)
        return [struct.unpack_from('<II', data, directory + 16 + index * 8)
                for index in range(named + numbered)]

    target = next(value for identifier, value in entries(0) if identifier == 24)  # RT_MANIFEST
    assert target & 0x80000000, 'Manifest resource directory missing'
    target = next(value for identifier, value in entries(target & 0x7fffffff) if identifier == 1)
    assert target & 0x80000000
    target = entries(target & 0x7fffffff)[0][1]
    assert not target & 0x80000000
    rva, length = struct.unpack_from('<II', data, root + target)
    manifest = ET.fromstring(data[file_offset(rva):file_offset(rva) + length].decode('utf-8-sig'))
    compatibility = '{urn:schemas-microsoft-com:compatibility.v1}'
    assert any(node.get('Id') == '{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}'
               for node in manifest.iter(compatibility + 'supportedOS')), 'Windows 10 compatibility missing'
    privileges = manifest.find('.//{urn:schemas-microsoft-com:asm.v3}requestedExecutionLevel')
    assert privileges is not None and privileges.get('level') == 'asInvoker', 'Unexpected elevation requirement'
    # .NET Framework should own awareness; a manifest dpiAware value can override its configuration.
    assert not any(node.tag.rsplit('}', 1)[-1] in ('dpiAware', 'dpiAwareness') for node in manifest.iter())
    config = ET.parse(str(executable) + '.config').getroot()
    options = config.find('System.Windows.Forms.ApplicationConfigurationSection')
    assert options is not None
    values = {node.get('key'): node.get('value') for node in options.findall('add')}
    assert values.get('DpiAwareness') == 'PerMonitorV2', 'Per-monitor V2 opt-in missing'
    assert values.get('EnableWindowsFormsHighDpiAutoResizing', 'true') != 'false', 'DPI resizing disabled'
    runtime = config.find('startup/supportedRuntime')
    assert runtime is not None and runtime.get('sku') == '.NETFramework,Version=v4.7.2'
    print('DPI packaging passed: embedded Windows manifest, no elevation, PerMonitorV2 configuration and framework target.')


if __name__ == '__main__':
    verify(sys.argv[1])
