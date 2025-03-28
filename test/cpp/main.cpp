#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winhttp.h>
#include <bcrypt.h>
#include <shellapi.h> // For CommandLineToArgvW
#include <assert.h>
#include <string>
#include <vector>
#include <iostream>
// #include <sstream> // No longer explicitly needed for fallback hex formatting
#include <iomanip>    // Keep for potential implicit needs or other formatting
#include <memory>   // For unique_ptr
#include <stdexcept> // For runtime_error
#include <filesystem> // For path
#include <span>       // For span (C++20)
#include <format>     // For format (C++20)

// Linker dependencies
#pragma comment(lib, "winhttp.lib")
#pragma comment(lib, "bcrypt.lib")
#pragma comment(lib, "shell32.lib")

// --- Custom Exception for Windows API Errors ---
class WindowsException : public std::runtime_error {
private:
    DWORD errorCode_;
    std::wstring functionName_;
    std::string formattedMessage_; // Store formatted message

    static std::string FormatWindowsError(DWORD errorCode, const std::wstring& functionName) {
        LPWSTR lpMsgBuf = nullptr;
        DWORD bufLen = FormatMessageW(
            FORMAT_MESSAGE_ALLOCATE_BUFFER |
            FORMAT_MESSAGE_FROM_SYSTEM |
            FORMAT_MESSAGE_IGNORE_INSERTS,
            NULL,
            errorCode,
            MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT),
            (LPWSTR)&lpMsgBuf,
            0, NULL);

        std::string message;
        if (bufLen > 0 && lpMsgBuf) {
            int narrowLen = WideCharToMultiByte(CP_ACP, 0, lpMsgBuf, bufLen, NULL, 0, NULL, NULL);
            if (narrowLen > 0) {
                std::vector<char> narrowBuf(narrowLen);
                WideCharToMultiByte(CP_ACP, 0, lpMsgBuf, bufLen, narrowBuf.data(), narrowLen, NULL, NULL);
                 message = std::string(narrowBuf.data(), narrowLen);
                 while (!message.empty() && (message.back() == '\r' || message.back() == '\n')) {
                    message.pop_back();
                 }
            } else {
                message = "(WideCharToMultiByte failed)";
            }
            LocalFree(lpMsgBuf);
        } else {
            message = "(FormatMessage failed)";
        }

        try {
             std::wstring wFunctionName = functionName;
             int fnNarrowLen = WideCharToMultiByte(CP_ACP, 0, wFunctionName.c_str(), -1, NULL, 0, NULL, NULL);
             std::string fnNarrow(fnNarrowLen, 0);
             WideCharToMultiByte(CP_ACP, 0, wFunctionName.c_str(), -1, &fnNarrow[0], fnNarrowLen, NULL, NULL);
             fnNarrow.pop_back(); // Remove null terminator

             return std::format("Error in {}: {} (Code: {})", fnNarrow, message, errorCode);
        }
        catch (const std::exception& fmtEx) {
             std::ostringstream oss; // Keep sstream include for this rare fallback case
             oss << "Error in function (std::format failed during exception formatting: " << fmtEx.what() << "): " << message << " (Code: " << errorCode << ")";
             return oss.str();
        }
    }

public:
    WindowsException(DWORD errorCode, const std::wstring& functionName)
        : std::runtime_error(FormatWindowsError(errorCode, functionName)),
          errorCode_(errorCode),
          functionName_(functionName),
          formattedMessage_(what())
    {}

    DWORD getErrorCode() const noexcept { return errorCode_; }
    const std::wstring& getFunctionName() const noexcept { return functionName_; }
    const char* what() const noexcept override { return formattedMessage_.c_str(); }
};


// --- RAII Deleters ---
struct WinHttpHandleDeleter { void operator()(HINTERNET handle) const { if (handle) WinHttpCloseHandle(handle); } };
struct HandleDeleter { void operator()(HANDLE handle) const { if (handle && handle != INVALID_HANDLE_VALUE) CloseHandle(handle); } };
struct BcryptAlgHandleDeleter { void operator()(BCRYPT_ALG_HANDLE handle) const { if (handle) BCryptCloseAlgorithmProvider(handle, 0); } };
struct BcryptHashHandleDeleter { void operator()(BCRYPT_HASH_HANDLE handle) const { if (handle) BCryptDestroyHash(handle); } };
struct HeapAllocDeleter { void operator()(PVOID ptr) const { if(ptr) HeapFree(GetProcessHeap(), 0, ptr); } };
struct LocalAllocDeleter { void operator()(HLOCAL ptr) const { if(ptr) LocalFree(ptr); } };

// --- unique_ptr Type Aliases ---
using unique_hinternet = std::unique_ptr<void, WinHttpHandleDeleter>;
using unique_handle = std::unique_ptr<void, HandleDeleter>;
using unique_bcrypt_alg_handle = std::unique_ptr<void, BcryptAlgHandleDeleter>;
using unique_bcrypt_hash_handle = std::unique_ptr<void, BcryptHashHandleDeleter>;
using unique_heap_ptr = std::unique_ptr<BYTE, HeapAllocDeleter>;
using unique_local_ptr = std::unique_ptr<LPWSTR[], LocalAllocDeleter>;


// --- Error Checking Helpers ---
inline void CheckWindowsError(BOOL success, const std::wstring& functionName) { if (!success) throw WindowsException(GetLastError(), functionName); }
inline void CheckBcryptError(NTSTATUS status, const std::wstring& functionName) { if (!BCRYPT_SUCCESS(status)) throw WindowsException(status, functionName); }

// --- Helper to convert byte buffer to hex string using std::format ---
std::wstring BytesToHexString(std::span<const BYTE> data) {
     std::wstring result;
     result.reserve(data.size() * 2); // Pre-allocate memory
     for (const BYTE byte : data) {
         // Format each byte as a two-digit lowercase hex number
         result += std::format(L"{:02x}", byte);
     }
     return result;
     // Fallback using stringstream REMOVED
}

// Case-insensitive wide string comparison (remains the same)
bool AreEqualIgnoreCase(const std::wstring& s1, const std::wstring& s2) {
    return CompareStringOrdinal(s1.c_str(), -1, s2.c_str(), -1, TRUE) == CSTR_EQUAL;
}

// --- Core Functions (Refactored) ---

// Returns HTTP status code on success, throws on API errors
DWORD DownloadFile(const std::wstring& url, const std::filesystem::path& destinationPath) {
    std::wcout << std::format(L"Attempting to download from: {}\n", url);
    std::wcout << std::format(L"Saving to: {}\n", destinationPath.wstring());

    unique_hinternet hSession{ WinHttpOpen(L"TerrapinCppClient/2.0", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0) };
    CheckWindowsError(hSession != nullptr, L"WinHttpOpen");

    URL_COMPONENTSW urlComp = { 0 };
    WCHAR szHostName[256] = { 0 };
    WCHAR szUrlPath[2048] = { 0 };

    urlComp.dwStructSize = sizeof(urlComp);
    urlComp.lpszHostName = szHostName;
    urlComp.dwHostNameLength = ARRAYSIZE(szHostName);
    urlComp.lpszUrlPath = szUrlPath;
    urlComp.dwUrlPathLength = ARRAYSIZE(szUrlPath);

    CheckWindowsError(WinHttpCrackUrl(url.c_str(), static_cast<DWORD>(url.length()), 0, &urlComp), L"WinHttpCrackUrl");
    assert(urlComp.nScheme == INTERNET_SCHEME_HTTPS);
    unique_hinternet hConnect{ WinHttpConnect(hSession.get(), szHostName, urlComp.nPort, 0) };
    CheckWindowsError(hConnect != nullptr, L"WinHttpConnect");

    unique_hinternet hRequest{ WinHttpOpenRequest(hConnect.get(), L"GET", szUrlPath, NULL, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, (urlComp.nScheme == INTERNET_SCHEME_HTTPS) ? WINHTTP_FLAG_SECURE : 0) };
    CheckWindowsError(hRequest != nullptr, L"WinHttpOpenRequest");

    CheckWindowsError(WinHttpSendRequest(hRequest.get(), WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0), L"WinHttpSendRequest");

    CheckWindowsError(WinHttpReceiveResponse(hRequest.get(), NULL), L"WinHttpReceiveResponse");

    DWORD dwStatusCode = 0;
    DWORD dwSize = sizeof(dwStatusCode);
    CheckWindowsError(WinHttpQueryHeaders(hRequest.get(), WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX, &dwStatusCode, &dwSize, WINHTTP_NO_HEADER_INDEX), L"WinHttpQueryHeaders (Status Code)");

    std::wcout << std::format(L"HTTP Status Code: {}\n", dwStatusCode);

    if (dwStatusCode == HTTP_STATUS_OK) {
        unique_handle hFile { CreateFileW(destinationPath.c_str(), GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL) };
        CheckWindowsError(hFile.get() != INVALID_HANDLE_VALUE, L"CreateFileW");

        std::vector<BYTE> buffer(8192); // 8KB buffer
        DWORD dwBytesRead = 0;
        DWORD dwBytesWritten = 0;

        while (WinHttpReadData(hRequest.get(), buffer.data(), static_cast<DWORD>(buffer.size()), &dwBytesRead) && dwBytesRead > 0) {
             CheckWindowsError(WriteFile(hFile.get(), buffer.data(), dwBytesRead, &dwBytesWritten, NULL), L"WriteFile");
             if (dwBytesRead != dwBytesWritten) {
                  throw WindowsException(ERROR_WRITE_FAULT, L"WriteFile (Partial Write)");
             }
        }
         DWORD lastError = GetLastError();
         if (lastError != ERROR_SUCCESS && lastError != ERROR_WINHTTP_CONNECTION_ERROR) { // Re-check error state if WinHttpReadData returned FALSE
            CheckWindowsError(FALSE, L"WinHttpReadData (After Loop)");
         }

        std::wcout << L"Download successful.\n";
    } else {
         std::wcerr << std::format(L"Download failed: Server returned status {}\n", dwStatusCode);
    }

    return dwStatusCode;
}


std::wstring CalculateFileSHA512(const std::filesystem::path& filePath) {
    std::wcout << std::format(L"Calculating SHA512 hash for: {}\n", filePath.wstring());

    unique_bcrypt_alg_handle hAlg { nullptr };
    NTSTATUS status = BCryptOpenAlgorithmProvider(reinterpret_cast<BCRYPT_ALG_HANDLE*>(&hAlg), BCRYPT_SHA512_ALGORITHM, NULL, 0);
    CheckBcryptError(status, L"BCryptOpenAlgorithmProvider");

    DWORD cbHashObject = 0, cbResult = 0;
    status = BCryptGetProperty(hAlg.get(), BCRYPT_OBJECT_LENGTH, (PBYTE)&cbHashObject, sizeof(DWORD), &cbResult, 0);
    CheckBcryptError(status, L"BCryptGetProperty (Object Length)");

    DWORD cbHashValue = 0;
    status = BCryptGetProperty(hAlg.get(), BCRYPT_HASH_LENGTH, (PBYTE)&cbHashValue, sizeof(DWORD), &cbResult, 0);
    CheckBcryptError(status, L"BCryptGetProperty (Hash Length)");

    unique_heap_ptr pbHashObject{ (PBYTE)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, cbHashObject) };
    if (!pbHashObject) throw std::bad_alloc();

    unique_heap_ptr pbHashValue{ (PBYTE)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, cbHashValue) };
    if (!pbHashValue) throw std::bad_alloc();

    unique_bcrypt_hash_handle hHash { nullptr };
    status = BCryptCreateHash(hAlg.get(), reinterpret_cast<BCRYPT_HASH_HANDLE*>(&hHash), pbHashObject.get(), cbHashObject, NULL, 0, 0);
    CheckBcryptError(status, L"BCryptCreateHash");

    unique_handle hFile{ CreateFileW(filePath.c_str(), GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_FLAG_SEQUENTIAL_SCAN, NULL) };
    CheckWindowsError(hFile.get() != INVALID_HANDLE_VALUE, L"CreateFileW (for hashing)");

    std::vector<BYTE> buffer(8192); // 8KB read buffer
    DWORD dwBytesRead = 0;
    while (ReadFile(hFile.get(), buffer.data(), static_cast<DWORD>(buffer.size()), &dwBytesRead, NULL) && dwBytesRead > 0) {
        status = BCryptHashData(hHash.get(), buffer.data(), dwBytesRead, 0);
        CheckBcryptError(status, L"BCryptHashData");
    }
    DWORD readError = GetLastError();
     if (readError != ERROR_SUCCESS && readError != ERROR_HANDLE_EOF) {
        throw WindowsException(readError, L"ReadFile (during hashing)");
    }

    status = BCryptFinishHash(hHash.get(), pbHashValue.get(), cbHashValue, 0);
    CheckBcryptError(status, L"BCryptFinishHash");

    std::span<const BYTE> hashSpan(pbHashValue.get(), cbHashValue);
    std::wstring hashString = BytesToHexString(hashSpan);

    std::wcout << std::format(L"Calculated SHA512: {}\n", hashString);
    return hashString;
}


int wmain() {
    int argc = 0;
    unique_local_ptr argv_ptr{ CommandLineToArgvW(GetCommandLineW(), &argc) };

    if (argv_ptr == nullptr || argc <= 1) {
        std::wcerr << L"Error: Failed to get command line arguments or no arguments provided.\n";
        return 1;
    }

    std::vector<std::wstring_view> args;
    LPWSTR* argv = argv_ptr.get();
    for (int i = 0; i < argc; ++i) { args.emplace_back(argv[i]); }


    std::wstring baseUrl, auth, user, packageUrl, expectedHash;
    std::filesystem::path destPath;

    for (size_t i = 1; i < args.size(); ++i) {
        const auto& arg = args[i];
        if ((arg == L"-b" || arg == L"/b") && i + 1 < args.size()) { baseUrl = args[++i]; }
        else if ((arg == L"-a" || arg == L"/a") && i + 1 < args.size()) { auth = args[++i]; }
        else if ((arg == L"-u" || arg == L"/u") && i + 1 < args.size()) { user = args[++i]; }
        else if ((arg == L"-p" || arg == L"/p") && i + 1 < args.size()) { packageUrl = args[++i]; }
        else if ((arg == L"-s" || arg == L"/s") && i + 1 < args.size()) { expectedHash = args[++i]; }
        else if ((arg == L"-d" || arg == L"/d") && i + 1 < args.size()) { destPath = args[++i]; }
        else { std::wcerr << std::format(L"Warning: Ignoring unrecognized or incomplete argument: {}\n", arg); }
    }

    if (packageUrl.empty() || expectedHash.empty() || destPath.empty()) {
        std::wcerr << L"Error: Missing required arguments.\n"
                   << L"Usage: <program_name> -p <package_url> -s <sha512_hash> -d <destination_path> [optional_args]\n";
        return 1;
    }

    std::wcout << L"--- Configuration ---\n";
    std::wcout << std::format(L"Package URL (-p): {}\n", packageUrl);
    std::wcout << std::format(L"Expected SHA512 (-s): {}\n", expectedHash);
    std::wcout << std::format(L"Destination Path (-d): {}\n", destPath.wstring());
    std::wcout << std::format(L"Base URL (-b): {} (Ignored)\n", baseUrl.empty() ? L"[Not Provided]" : baseUrl);
    std::wcout << std::format(L"Auth (-a): {} (Ignored)\n", auth.empty() ? L"[Not Provided]" : auth);
    std::wcout << std::format(L"User (-u): {} (Ignored)\n", user.empty() ? L"[Not Provided]" : user);
    std::wcout << L"--------------------\n";

    int exitCode = 1;
    try {
        DWORD httpStatus = DownloadFile(packageUrl, destPath);

        if (httpStatus != HTTP_STATUS_OK) {
            std::wcerr << L"Download step did not complete successfully (HTTP Status: " << httpStatus << L").\n";
            return 1;
        }

        std::wstring calculatedHash = CalculateFileSHA512(destPath);

        std::wcout << L"Comparing Hashes...\n";
        std::wcout << std::format(L" Expected: {}\n", expectedHash);
        std::wcout << std::format(L" Actual:   {}\n", calculatedHash);

        if (AreEqualIgnoreCase(expectedHash, calculatedHash)) {
            std::wcout << L"SUCCESS: SHA512 hash verification passed.\n";
            exitCode = 0;
        } else {
            std::wcerr << L"ERROR: SHA512 hash verification FAILED!\n";
            exitCode = 2;
        }
    }
    catch (const WindowsException& ex) {
        std::wcerr << L"Operation failed due to Windows API error:\n" << ex.what() << std::endl;
        exitCode = 1;
    }
    catch (const std::bad_alloc& ex) {
        std::wcerr << L"Operation failed due to memory allocation error: " << ex.what() << std::endl;
        exitCode = 1;
    }
    catch (const std::exception& ex) {
        std::wcerr << L"Operation failed due to an unexpected error: " << ex.what() << std::endl;
        exitCode = 1;
    }

    return exitCode;
}