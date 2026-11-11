import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('bathjun_build',Path(__file__).resolve().parents[2]/'build-windows.py')
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class ReleaseVersionTest(unittest.TestCase):
    def test_order(self):
        versions=['1.3.0','2.0.0-beta1','2.0.0-beta2','2.0.0-rc','2.0.0-rc2','2.0.0','2.0.1-rc','2.0.2','2.1.0-beta4','2.1.0']
        numbers=[tuple(map(int,module.windows_file_version(v).split('.'))) for v in versions]
        self.assertEqual(numbers,sorted(numbers))
        self.assertEqual(module.windows_file_version('2.0.0-beta1'),'2.0.0.1')
        self.assertEqual(module.windows_file_version('2.0.0-beta.2'),'2.0.0.2')
        self.assertEqual(module.windows_file_version('2.0.0-rc'),'2.0.0.32769')
        self.assertEqual(module.windows_file_version('2.0.0-rc2'),'2.0.0.32770')
        self.assertEqual(module.windows_file_version('2.0.0-rc.2'),'2.0.0.32770')
        self.assertEqual(module.windows_file_version('2.0.0'),'2.0.0.65535')
        self.assertEqual(module.windows_file_version('2.1.0-beta4'),'2.1.0.4')
        self.assertEqual(module.windows_file_version('2.1.0'),'2.1.0.65535')
    def test_rejects_invalid_versions(self):
        for version in ['2.0.0-beta0','2.0.0-beta32768','2.0.0-rc32767','2.0.0-rc0','2.0.0-rc65535','2.0.0-rc.0','2.0.0-rc.65535','2.0.0-beta','2.0.0-rcx','65536.0.0']:
            with self.subTest(version=version),self.assertRaises(ValueError):module.windows_file_version(version)

if __name__=='__main__':unittest.main()
